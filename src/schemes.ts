/**
 * One `p4://` URL scheme for omp's `read` tool, prompt references and transcript:
 *
 *   p4://12345                         description, status and files of any changelist
 *   p4://12345/diff                    its diff (shelf if pending, revisions if submitted)
 *   p4://review/4521                   a P4 Code Review review with threaded comments
 *   p4://review/4521/diff              diff of the review's latest version
 *   p4://depot/main/rtl/fifo.sv#5      a depot file at any revision, no sync
 *   p4://depot/main/rtl/               a depot folder listing
 *
 * A depot path reads as Perforce syntax with `p4:` in front. Perforce forbids
 * purely numeric depot names, so a leading number is always a changelist.
 *
 * omp has no extension API for schemes, so this registers handlers on omp's own
 * internal URL router (the one behind pr:// and conflict://). That router is
 * internal: if a future omp moves it, registration fails quietly and the rest
 * of the extension keeps working. Built-in or already-registered schemes are
 * never replaced.
 */
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { changeFiles } from "./diff";
import { p4 } from "./p4";
import { changeDiff, joinDiffs } from "./review";
import { formatComments, getComments, listMyReviews, resolveReview } from "./review-server";
import { p4OwnsPath } from "./roots";
import { findWorkspace, type Workspace } from "./workspace";

/** Candidates for prompt autocomplete; refreshed off the keystroke path by {@link refreshCompletions}. */
const completions = { change: [] as UrlCompletion[], review: [] as UrlCompletion[], depot: [] as UrlCompletion[] };
/** Perforce clients of the session's roots, newest refresh; also gates the system-prompt entry. */
let knownWorkspaces: Workspace[] = [];

/**
 * The client to run p4 under: the caller's cwd when it is a Perforce root, else
 * the session's first client (so p4:// works from a git root of a mixed session).
 */
async function workspaceFor(context: ResolveContext | undefined): Promise<Workspace> {
	const cwd = context?.cwd ?? process.cwd();
	const here = await findWorkspace(cwd);
	const ws = here && p4OwnsPath(here, cwd) ? here : knownWorkspaces[0];
	if (!ws) throw new Error("No Perforce client in this session, so p4:// URLs cannot be resolved here.");
	return ws;
}

/** Everything after `scheme://`, as typed (keeps `#rev`, which URL parsing would treat as a fragment). */
function rest(url: InternalUrl, scheme: string): string {
	const raw = url.rawHref ?? url.href;
	return raw.slice(raw.toLowerCase().indexOf(`${scheme}://`) + scheme.length + 3);
}

function markdown(url: InternalUrl, content: string, immutable = false): InternalResource {
	return { url: url.rawHref ?? url.href, content, contentType: "text/markdown", immutable };
}

function plain(url: InternalUrl, content: string, notes?: string[], immutable = false): InternalResource {
	return { url: url.rawHref ?? url.href, content, contentType: "text/plain", notes, immutable };
}

// ── Changelists: p4://<n>, p4://<n>/diff ────────────────────────────────────

async function resolveChange(url: InternalUrl, ws: Workspace, change: string, sub: string | undefined): Promise<InternalResource> {
	if (sub === "diff") {
		const { pieces, label } = await changeDiff(ws, change);
		return plain(url, pieces.length ? joinDiffs(pieces) : "(no files)", [label]);
	}
	if (sub) throw new Error(`Unknown path '${sub}'; use p4://${change} or p4://${change}/diff.`);

	const { records, errors, warnings } = await p4(["describe", "-s", "-S", change], { cwd: ws.cwd });
	if (errors.length > 0 || !records[0]?.change) {
		throw new Error(`p4 describe ${change}: ${[...errors, ...warnings].join("; ") || "no such changelist"}`);
	}
	const rec = records[0];
	const shelved = rec.status === "pending" && Boolean(rec.depotFile0);
	const { files } = shelved || rec.status !== "pending" ? await changeFiles(ws, change, shelved) : { files: [] };
	const when = rec.time ? new Date(Number(rec.time) * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
	const lines = [
		`# Change ${change} — ${rec.status}${shelved ? ", shelved" : ""}`,
		`${rec.user}@${rec.client}${when ? `, ${when}` : ""}`,
		"",
		(rec.desc ?? "").trim(),
		"",
		files.length ? `## ${shelved ? "Shelved files" : "Files"}` : "(no files, or pending and not shelved)",
		...files.map(f => `- ${f.action} ${f.depotFile}#${f.rev}`),
		"",
		`Diff: p4://${change}/diff`,
	];
	return markdown(url, lines.join("\n"), rec.status === "submitted");
}

// ── Reviews: p4://review/<id>, p4://review/<id>/diff ────────────────────────

async function resolveReviewUrl(url: InternalUrl, ws: Workspace, ref: string, sub: string | undefined): Promise<InternalResource> {
	const review = await resolveReview(ws, Number(ref));
	if (sub === "diff") {
		// A review's id is itself a changelist holding the shelf of its latest version.
		let { pieces, label } = await changeDiff(ws, String(review.id));
		const latest = review.changes.at(-1);
		if (pieces.length === 0 && latest) ({ pieces, label } = await changeDiff(ws, String(latest)));
		return plain(url, pieces.length ? joinDiffs(pieces) : "(no files)", [`Review ${review.id}: ${label}`]);
	}
	if (sub) throw new Error(`Unknown path '${sub}'; use p4://review/${ref} or p4://review/${ref}/diff.`);
	const comments = await getComments(ws, review.id);
	return markdown(url, `${formatComments(review, comments, false)}\n\nDiff: p4://review/${review.id}/diff`);
}

// ── Depot files and folders: p4://<depot path>[#rev|@change] ───────────────

/** Split `depot/main/rtl/fifo.sv#5` into `//depot/main/rtl/fifo.sv` and `#5`. */
export function parseDepotRef(ref: string): { path: string; rev: string; folder: boolean } {
	const at = ref.search(/[#@]/);
	const body = at < 0 ? ref : ref.slice(0, at);
	const rev = at < 0 ? "" : ref.slice(at);
	return { path: `//${body.replace(/^\/+/, "").replace(/\/+$/, "")}`, rev, folder: body.endsWith("/") || !body.includes("/") };
}

async function resolveDepot(url: InternalUrl, ws: Workspace, path: string): Promise<InternalResource> {
	const ref = parseDepotRef(path);
	if (!ref.folder) {
		const result = await p4(["print", `${ref.path}${ref.rev}`], { cwd: ws.cwd, tagged: false });
		const newline = result.stdout.indexOf("\n");
		if (result.errors.length === 0 && result.exitCode === 0 && newline > 0) {
			const header = result.stdout.slice(0, newline).trim(); // //depot/f#5 - edit change 123 (text)
			const body = result.stdout.slice(newline + 1);
			if (body.includes("\0")) return plain(url, `(binary file: ${header})`, [header], true);
			return plain(url, body, [header], ref.rev.length > 0);
		}
		const failure = result.errors.join("; ") || (result.exitCode !== 0 ? result.stdout.trim() : "");
		if (failure && !/no such file|not in client view/i.test(failure)) {
			throw new Error(`p4 print ${ref.path}${ref.rev}: ${failure}`);
		}
	}
	return markdown(url, await listFolder(ws, ref.path, ref.rev));
}

async function listFolder(ws: Workspace, folder: string, rev: string): Promise<string> {
	const pattern = `${folder}/*${rev}`;
	const [dirs, files] = await Promise.all([
		p4(["dirs", pattern], { cwd: ws.cwd }),
		p4(["files", "-e", pattern], { cwd: ws.cwd }),
	]);
	const subdirs = dirs.records.map(r => r.dir).filter(Boolean);
	const entries = files.records.filter(r => r.depotFile);
	if (subdirs.length === 0 && entries.length === 0) {
		const why = [...dirs.errors, ...files.errors, ...files.warnings].join("; ");
		throw new Error(`Nothing at ${folder}${rev}${why ? `: ${why}` : ""}`);
	}
	const url = (p: string) => `p4://${p.replace(/^\/\//, "")}`;
	return [
		`# ${folder}/${rev}`,
		"",
		...subdirs.map(d => `- ${url(d)}/`),
		...entries.map(f => `- ${url(f.depotFile)}  #${f.rev} ${f.type}, change ${f.change}`),
	].join("\n");
}

// ── The p4:// handler ───────────────────────────────────────────────────────

/** What a `p4://` path addresses. */
export function classify(path: string):
	| { kind: "change"; change: string; sub?: string }
	| { kind: "review"; id: string; sub?: string }
	| { kind: "depot"; path: string } {
	const clean = path.replace(/^\/+/, "");
	const change = /^(\d+)(?:\/([^/]+))?\/?$/.exec(clean);
	if (change) return { kind: "change", change: change[1], sub: change[2] };
	const review = /^review\/(\d+)(?:\/([^/]+))?\/?$/.exec(clean);
	if (review) return { kind: "review", id: review[1], sub: review[2] };
	return { kind: "depot", path: clean };
}

export const p4Handler: ProtocolHandler = {
	scheme: "p4",
	spec: { backing: "remote", selectors: "lines", immutable: false },
	promptDoc: () =>
		knownWorkspaces.length > 0
			? "p4://<change> and p4://<change>/diff — a Perforce changelist and its diff (shelf if pending); p4://review/<id>[/diff] — a P4 Code Review review with threaded comments; p4://<depot path>[#rev|@change] — any depot file at any revision without syncing (trailing / lists a folder)."
			: undefined,
	complete: async () => [...completions.change, ...completions.review, ...completions.depot],
	async resolve(url, context) {
		const ws = await workspaceFor(context);
		const target = classify(rest(url, "p4"));
		if (target.kind === "change") return resolveChange(url, ws, target.change, target.sub);
		if (target.kind === "review") return resolveReviewUrl(url, ws, target.id, target.sub);
		if (!target.path) throw new Error("Use p4://<change>, p4://review/<id> or p4://<depot path>.");
		return resolveDepot(url, ws, target.path);
	},
};

// ── Registration and completion cache ───────────────────────────────────────

/** Register p4:// on omp's router; false when the name is taken or the router is unavailable. */
export async function registerSchemes(): Promise<boolean> {
	try {
		const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls/router");
		const router = InternalUrlRouter.instance();
		const existing = router.getHandler(p4Handler.scheme);
		if (existing && existing !== p4Handler) return false;
		router.register(p4Handler);
		return true;
	} catch {
		return false;
	}
}

/** Fill the autocomplete lists for the session's clients. Runs at session start and after turns, never per keystroke. */
export async function refreshCompletions(workspaces: Workspace[]): Promise<void> {
	knownWorkspaces = workspaces;
	const ws = workspaces[0];
	if (!ws) return;
	const [changes, depots, reviews] = await Promise.all([
		Promise.all(
			workspaces.map(w => p4(["changes", "-s", "pending", "-c", w.client, "-m", "20"], { cwd: w.cwd }).catch(() => undefined)),
		),
		// Depots almost never change; list them once per process.
		completions.depot.length > 0 ? Promise.resolve(undefined) : p4(["depots"], { cwd: ws.cwd }).catch(() => undefined),
		listMyReviews(ws).catch(() => []),
	]);
	completions.change = changes.flatMap((result, i) =>
		(result?.records ?? []).map(r => ({
			value: `p4://${r.change}`,
			description: `${workspaces.length > 1 ? `${workspaces[i].client}: ` : ""}${(r.desc ?? "").trim().split("\n")[0]}`,
		})),
	);
	if (depots) completions.depot = depots.records.filter(r => r.name).map(r => ({ value: `p4://${r.name}/`, description: r.type }));
	completions.review = reviews.map(r => ({
		value: `p4://review/${r.id}`,
		description: `${r.state} · ${r.author} · ${r.description.trim().split("\n")[0]}`,
	}));
}
