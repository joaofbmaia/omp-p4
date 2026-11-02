/**
 * `/p4-change`: split a changelist by topic. Each part gets a description, or
 * joins one of your existing pending changelists when it belongs there; the
 * first new part keeps the original changelist number (and any review on it).
 * Splits are per file, since Perforce cannot put hunks of one file into
 * different changelists. Never submits.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { renderDiffs } from "./diff";
import type { ChangeRouter } from "./changes";
import { p4 } from "./p4";
import { waitForReview } from "./review-server";
import { p4OwnsPath } from "./roots";
import {
	type OpenedFile,
	openedFiles,
	type PendingChange,
	pendingChanges,
	readinessProblems,
	reconcile,
	reopen,
	setDescription,
	shelve,
	withReviewKeyword,
	type Workspace,
} from "./workspace";

export interface PlannedChange {
	description: string;
	files: string[];
	/** Join this existing pending changelist instead of making a new one. */
	change?: string;
}

const DIFF_BUDGET_CHARS = 80_000;
const TEMPLATE_PATHS = [".omp/p4-description.md", ".p4-description.md"];

export async function runChangeCommand(ws: Workspace, args: string, ctx: ExtensionCommandContext, router: ChangeRouter): Promise<void> {
	const flag = (name: string) => new RegExp(`(^|\\s)--${name}(?=\\s|$)`).test(args);
	const single = flag("single");
	// --review is the team flow: #review in each description, then shelve.
	const startReviews = flag("review");
	const shelveAfter = startReviews || flag("shelve");
	const number = /(?:^|\s)(\d+)(?=\s|$)/.exec(args)?.[1];
	const hint = args.replace(/(^|\s)--(single|shelve|review)(?=\s|$)/g, " ").replace(/(?:^|\s)\d+(?=\s|$)/, " ").trim();

	const pending = await pendingChanges(ws);
	const source = number ?? router.current(ws) ?? router.touched(ws).find(c => router.isCreated(ws, c));
	const sourceInfo = pending.find(c => c.change === source);
	if (!source || !sourceInfo) {
		ctx.ui.notify(
			source ? `Changelist ${source} is not a pending changelist on ${ws.client}.` : "Nothing changed in this session yet. Name a changelist: /p4-change <n>",
			"info",
		);
		return;
	}
	await offerReconcile(ws, ctx, source);

	const files = await openedFiles(ws, source);
	if (files.length === 0) {
		ctx.ui.notify(`Nothing open in changelist ${source}.`, "info");
		return;
	}
	const problems = await readinessProblems(ws, files);
	if (problems.length > 0) {
		if (shelveAfter) {
			ctx.ui.notify(`Not shelving until these are fixed (p4_resolve can help):\n${problems.join("\n")}`, "error");
			return;
		}
		const go = await ctx.ui.confirm("Some files are not ready to submit. Split anyway?", problems.join("\n"));
		if (!go) return;
	}
	if (!ctx.runEphemeralTurn) {
		ctx.ui.notify("This omp host cannot run side turns; use p4 change manually.", "error");
		return;
	}

	const others = pending.filter(c => c.change !== source);
	ctx.ui.setWorkingMessage?.("Grouping files and drafting descriptions…");
	let plan: PlannedChange[];
	try {
		const prompt = await buildPrompt(ws, files, { single, hint, current: sourceInfo, others });
		const { replyText } = await ctx.runEphemeralTurn({ promptText: prompt, tools: false, dedupeReply: false, replyMaxBytes: 64_000 });
		plan = normalizePlan(parsePlan(replyText), files, single, new Set(others.map(c => c.change)));
		if (startReviews) plan = plan.map(c => (c.change ? c : { ...c, description: withReviewKeyword(c.description, true) }));
	} finally {
		ctx.ui.setWorkingMessage?.();
	}

	// The first new part keeps the original number, so shelves and reviews on it stay attached.
	const keeper = plan.find(c => !c.change);
	const summary = plan
		.map((c, i) => {
			const count = `${c.files.length} file${c.files.length === 1 ? "" : "s"}`;
			const head = c.change
				? `#${i + 1} → your changelist ${c.change} "${others.find(o => o.change === c.change)?.desc.split("\n")[0] ?? ""}" (${count})`
				: `#${i + 1} ${c === keeper ? `stays changelist ${source}` : "new changelist"} (${count})\n${c.description}`;
			return `${head}\n  ${c.files.join("\n  ")}`;
		})
		.join("\n\n");
	const verb = startReviews ? "Apply this and start reviews" : shelveAfter ? "Apply this and shelve" : "Apply this split";
	const ok = await ctx.ui.confirm(`${verb}? (${plan.length} part${plan.length === 1 ? "" : "s"})`, summary);
	if (!ok) {
		ctx.ui.notify(`Kept everything in changelist ${source}.`, "info");
		return;
	}

	const targets: string[] = [];
	for (const part of plan) {
		let target: string;
		if (part.change) target = part.change;
		else if (part === keeper) {
			target = source;
			if (part.description.trim() !== sourceInfo.desc.trim()) await setDescription(ws, source, part.description);
			router.recordDescription(ws, source, part.description);
		} else {
			target = await router.createFor(ws, part.description);
		}
		const moving = part.files.filter(f => files.find(x => x.depotFile === f)?.change !== target);
		await reopen(ws, target, moving);
		for (const f of part.files) router.noteLanding(ws, target, files.find(x => x.depotFile === f)?.localPath ?? f, files.find(x => x.depotFile === f)?.action ?? "edit");
		targets.push(target);
	}
	if (keeper) router.follow(ws, source);
	if (shelveAfter) for (const target of new Set(targets)) await shelve(ws, target);
	await router.dropEmpty(ws);

	const list = [...new Set(targets)].join(", ");
	if (startReviews) {
		ctx.ui.setWorkingMessage?.("Waiting for P4 Code Review to pick up the shelves…");
		const unique = [...new Set(targets)];
		const reviews = await Promise.all(unique.map(n => waitForReview(ws, Number(n)).catch(() => undefined)));
		ctx.ui.setWorkingMessage?.();
		const lines = unique.map((n, i) =>
			reviews[i] ? `change ${n} → review ${reviews[i]!.id} (p4://review/${reviews[i]!.id})` : `change ${n} → shelved; no review yet (its description may lack #review)`,
		);
		ctx.ui.notify(`Shelved for review:\n${lines.join("\n")}\nRe-shelve with p4_shelve to update a review after fixes.`, "info");
		return;
	}
	ctx.ui.notify(
		shelveAfter
			? `Shelved changelists ${list}. Update a shelf after fixes with p4_shelve.`
			: `Split into changelists ${list}. Review with 'p4 describe -du <n>', submit with 'p4 submit -c <n>'.`,
		"info",
	);
}

/** Show what bash or other tools changed outside p4 and offer to open it. */
async function offerReconcile(ws: Workspace, ctx: ExtensionCommandContext, change: string): Promise<void> {
	const scope = `${ws.cwd}/...`;
	let preview;
	try {
		preview = await reconcile(ws, [scope], { preview: true, timeoutMs: 120_000 });
	} catch (err) {
		ctx.ui.notify(`Skipped reconcile preview of ${scope}: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return;
	}
	// A git checkout nested in the client (and its .git internals) belongs to git, not to this changelist.
	preview.entries = preview.entries.filter(e => p4OwnsPath(ws, e.localPath));
	if (preview.entries.length === 0) return;
	const list = preview.entries.map(e => `${e.action.padEnd(8)} ${e.depotFile}`).join("\n");
	const include = await ctx.ui.confirm(
		`${preview.entries.length} change${preview.entries.length === 1 ? "" : "s"} not yet opened in p4. Open them in changelist ${change}?`,
		list,
	);
	if (include) await reconcile(ws, preview.entries.map(e => e.localPath), { change });
}

async function buildPrompt(
	ws: Workspace,
	files: OpenedFile[],
	options: { single: boolean; hint: string; current: PendingChange; others: PendingChange[] },
): Promise<string> {
	const { text: diffs, truncated } = await renderDiffs(ws, files, { maxChars: DIFF_BUDGET_CHARS });
	const recent = await p4(["changes", "-s", "submitted", "-m", "8", "-l", `${ws.cwd}/...`], { cwd: ws.cwd });
	const examples = recent.records
		.map(r => r.desc?.trim())
		.filter(Boolean)
		.slice(0, 8)
		.map(d => `---\n${d}`)
		.join("\n");
	const template = await readTemplate(ws);

	return [
		`These files are open in Perforce changelist ${options.current.change}, currently described as:\n${options.current.desc || "(no description)"}`,
		"Write Perforce changelist descriptions for them, using what you know from this conversation about why they changed. Keep a good existing description rather than rewriting it.",
		options.single
			? "Put every file in ONE changelist."
			: "Group the files into one or more changelists. Split only when the changes are clearly independent and each group stands on its own; every file goes in exactly one group. A file cannot be split across changelists.",
		options.others.length && !options.single
			? `If a group clearly continues one of the user's other pending changelists, put it there by giving "change" instead of "description":\n${options.others.map(c => `  ${c.change}: ${c.desc.split("\n")[0]}`).join("\n")}`
			: "",
		"Reply with JSON only, no prose and no code fence:",
		'{"changelists":[{"description":"<summary line>\\n\\n<body>","files":["//depot/path", ...]}, {"change":"<existing number>","files":[...]}]}',
		"Use depot paths exactly as listed.",
		template ? `Follow this description template:\n${template}` : "",
		examples ? `Match the style of recent submitted changelists here:\n${examples}` : "",
		options.hint ? `Additional instructions from the user: ${options.hint}` : "",
		`Files:\n${files.map(f => `${f.action.padEnd(12)} ${f.depotFile}`).join("\n")}`,
		truncated.length > 0 ? `(Diffs truncated for: ${truncated.join(", ")})` : "",
		`Diffs:\n${diffs}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

async function readTemplate(ws: Workspace): Promise<string | undefined> {
	for (const dir of [ws.cwd, ws.root]) {
		for (const rel of TEMPLATE_PATHS) {
			const text = await fs.readFile(path.join(dir, rel), "utf8").catch(() => undefined);
			if (text?.trim()) return text.trim();
		}
	}
	return undefined;
}

export function parsePlan(reply: string): PlannedChange[] {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`Model reply had no JSON plan:\n${reply.slice(0, 500)}`);
	const parsed = JSON.parse(reply.slice(start, end + 1)) as { changelists?: unknown };
	if (!Array.isArray(parsed.changelists)) throw new Error("Model reply is missing 'changelists'.");
	return parsed.changelists.map(c => {
		const entry = c as { description?: unknown; files?: unknown; change?: unknown };
		const change = typeof entry.change === "string" || typeof entry.change === "number" ? String(entry.change) : undefined;
		return {
			description: typeof entry.description === "string" ? entry.description : "",
			files: Array.isArray(entry.files) ? entry.files.filter((f): f is string => typeof f === "string") : [],
			...(change ? { change } : {}),
		};
	});
}

/**
 * Make the plan safe to apply: drop unknown paths and duplicates, drop joins into
 * changelists that are not the user's pending ones, put files the model forgot
 * into the first group, drop empty groups.
 */
export function normalizePlan(
	plan: PlannedChange[],
	files: OpenedFile[],
	single: boolean,
	existing: Set<string> = new Set(),
): PlannedChange[] {
	const known = new Set(files.map(f => f.depotFile));
	const seen = new Set<string>();
	let groups: PlannedChange[] = plan
		.map(c => {
			const join = !single && c.change && existing.has(c.change) ? c.change : undefined;
			return {
				description: c.description.trim() || "Changes made with omp",
				files: c.files.filter(f => known.has(f) && !seen.has(f) && seen.add(f)),
				...(join ? { change: join } : {}),
			};
		})
		.filter(c => c.files.length > 0);
	if (groups.length === 0) groups = [{ description: plan[0]?.description.trim() || "Changes made with omp", files: [] }];
	const missing = [...known].filter(f => !seen.has(f));
	groups[0].files.push(...missing);
	if (single && groups.length > 1) {
		return [{ description: groups[0].description, files: groups.flatMap(g => g.files) }];
	}
	keepMovesTogether(groups, files);
	return groups.filter(g => g.files.length > 0);
}

/** p4 refuses to submit half a move: pull each move/delete into its move/add's group. */
function keepMovesTogether(groups: PlannedChange[], files: OpenedFile[]): void {
	const groupOf = new Map<string, PlannedChange>();
	for (const g of groups) for (const f of g.files) groupOf.set(f, g);
	for (const file of files) {
		if (file.action !== "move/add" || !file.movedFile) continue;
		const home = groupOf.get(file.depotFile);
		const other = groupOf.get(file.movedFile);
		if (!home || !other || home === other) continue;
		other.files = other.files.filter(f => f !== file.movedFile);
		home.files.push(file.movedFile);
		groupOf.set(file.movedFile, home);
	}
}
