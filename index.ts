/**
 * omp-p4: Perforce support for oh-my-pi.
 *
 * - Check-out on write: `edit`/`write` on a read-only depot file runs `p4 edit` and retries.
 * - Adds, deletes and moves made by `edit`/`write` are reconciled once per turn.
 * - Everything lands in one pending "work" changelist; `/p4-change` splits and describes it.
 * - Shelves, resolves (through omp's conflict:// flow) and P4 Code Review comments.
 * - `/p4-review` runs omp's review pipeline on any Perforce diff; `/branch` rewinds can restore files.
 *
 * Sessions with several roots (`/add-dir`) can mix Perforce clients and git repos: each
 * path belongs to its nearest version control, and git paths are left alone.
 * Outside a Perforce client (or without a `p4` binary) the extension does nothing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mayWriteFiles, scanTargets, unopenedChanges } from "./src/bash-watch";
import { runChangeCommand } from "./src/change-plan";
import { renderDiffs } from "./src/diff";
import { ignoreState, rememberDecline, wasDeclined, writeIgnore } from "./src/ignore-sync";
import { isLoginError, isTrustError, P4Error, p4, p4Strict } from "./src/p4";
import { loadDiffRenderer, renderDiffText, renderOpened, renderResolve, renderReview, type ThemeLike } from "./src/render";
import { runReviewCommand } from "./src/review";
import {
	formatComments,
	getComments,
	postComment,
	resolveReview,
	setTaskState,
	waitForReview,
} from "./src/review-server";
import {
	canonical,
	defaultWorkspace,
	describeRoots,
	groupByWorkspace,
	p4OwnsPath,
	p4Workspaces,
	type RootInfo,
	sessionRoots,
	workspaceForChange,
	workspaceForPath,
} from "./src/roots";
import { refreshCompletions, registerSchemes } from "./src/schemes";
import { applyRestore, describePlan, planRestore, type Snapshot, takeSnapshot } from "./src/snapshots";
import {
	findWorkspace,
	openedFiles,
	openForDelete,
	openForEdit,
	convertMarkersToGit,
	pendingResolves,
	readinessProblems,
	reconcile,
	resolve,
	type ResolveMode,
	ensureReviewKeyword,
	hasReviewKeyword,
	changeDescription,
	shelve,
	unshelve,
	WORK_TAG,
	type Workspace,
	existingWorkChange,
	workChange,
} from "./src/workspace";

const P4_TOOLS = [
	"p4_opened",
	"p4_diff",
	"p4_changes",
	"p4_describe",
	"p4_reconcile",
	"p4_shelve",
	"p4_unshelve",
	"p4_resolve",
	"p4_review_comments",
	"p4_review_reply",
	"p4_review_task",
];
const DIFF_TOOL_BUDGET_CHARS = 120_000;

export default function p4Extension(pi: ExtensionAPI) {
	const type = pi.arktype;
	pi.setLabel("Perforce");
	// p4:// lives on omp's process-wide URL router; registering again is a no-op.
	void registerSchemes();
	void loadDiffRenderer();

	// Transcript rendering: a one-line summary collapsed, full coloured output expanded.
	const text = (s: string) => new pi.pi.Text(s, 0, 0);
	const resultText = (result: { content: { type: string; text?: string }[] }) =>
		result.content.map(c => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
	const callTitle = (label: string, detail: string) => (_args: unknown, _options: unknown, theme: ThemeLike) =>
		text(`${theme.fg("toolTitle", theme.bold(label))}${detail ? ` ${theme.fg("dim", detail)}` : ""}`);
	const renderers = {
		opened: {
			renderCall: (args: unknown, _o: unknown, theme: ThemeLike) =>
				text(theme.fg("toolTitle", theme.bold("P4 Opened")) + theme.fg("dim", (args as { all?: boolean })?.all ? " all changelists" : " work changelist")),
			renderResult: (result: { content: { type: string; text?: string }[]; details?: unknown }, o: { expanded: boolean }, theme: ThemeLike) =>
				text(renderOpened((result.details as { files?: [] } | undefined)?.files ?? [], theme, o.expanded)),
		},
		diff: {
			renderCall: (args: unknown, o: unknown, theme: ThemeLike) =>
				callTitle("P4 Diff", ((args as { files?: string[] })?.files ?? []).join(", "))(args, o, theme),
			renderResult: (result: { content: { type: string; text?: string }[] }, o: { expanded: boolean }, theme: ThemeLike) =>
				text(renderDiffText(resultText(result), theme, o.expanded)),
		},
		resolve: {
			renderCall: (args: unknown, o: unknown, theme: ThemeLike) => {
				const a = args as { action?: string; files?: string[] } | undefined;
				return callTitle("P4 Resolve", [a?.action, ...(a?.files ?? [])].filter(Boolean).join(" "))(args, o, theme);
			},
			renderResult: (result: { content: { type: string; text?: string }[]; details?: unknown }, o: { expanded: boolean }, theme: ThemeLike) =>
				text(renderResolve(resultText(result), result.details as { pending?: unknown[]; markers?: unknown[] }, theme, o.expanded)),
		},
		review: {
			renderCall: (args: unknown, o: unknown, theme: ThemeLike) => {
				const review = (args as { review?: string } | undefined)?.review;
				return callTitle("P4 Review", review ? `#${review}` : "")(args, o, theme);
			},
			renderResult: (result: { content: { type: string; text?: string }[] }, o: { expanded: boolean }, theme: ThemeLike) =>
				text(renderReview(resultText(result), theme, o.expanded)),
		},
	};

	/** Why the last check-out attempt for a path failed, surfaced to the model with the tool error. */
	const editFailures = new Map<string, string>();
	/** p4 warnings from a successful check-out (not at head, opened elsewhere), surfaced with the tool result. */
	const editNotes = new Map<string, string[]>();
	/** Paths edit/write touched since the last reconcile, keyed by workspace client. */
	const pendingReconcile = new Map<string, { ws: Workspace; paths: Set<string> }>();
	/** Code state before each prompt's first change, keyed by that prompt's user message entry, then by client. */
	const snapshots = new Map<string, Map<string, Snapshot>>();
	/** Whether the current prompt already has its snapshot (taken lazily, on the first mutating tool call). */
	let snapshotTaken = false;
	/** Something p4-visible changed since the footer was last refreshed. */
	let statusDirty = true;
	/** When the p4:// autocomplete lists were last refreshed. */
	let completionsAt = 0;
	const COMPLETIONS_TTL_MS = 5 * 60_000;
	/** Whether this extension hid its tools because no session root is a Perforce client. */
	let toolsHidden = false;

	const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

	/** ui.notify, falling back to stderr where there is no UI (print mode) so messages aren't lost. */
	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI && ctx.mode !== "print") ctx.ui.notify(message, level);
		else process.stderr.write(`[p4] ${message}\n`);
	}
	const isDepotPath = (p: string) => p.startsWith("//");

	/** Open adds/deletes/moves queued by edit/write in one `p4 reconcile` per client. */
	async function flushReconcile(): Promise<string[]> {
		const problems: string[] = [];
		for (const [client, { ws, paths }] of pendingReconcile) {
			pendingReconcile.delete(client);
			statusDirty = true;
			try {
				await reconcile(ws, [...paths]);
			} catch (err) {
				problems.push(`p4 reconcile failed for ${[...paths].join(", ")}: ${errorText(err)}`);
			}
		}
		return problems;
	}

	/**
	 * The workspace a tool call is about, with queued reconciles applied: the one
	 * owning `root` or the first local path, the client owning `change`, else the
	 * cwd's (or the first Perforce root's).
	 */
	async function ready(ctx: ExtensionContext, hint: { root?: string; paths?: string[]; change?: string } = {}): Promise<Workspace> {
		await flushReconcile();
		const local = hint.paths?.find(p => !isDepotPath(p));
		let ws: Workspace | null = null;
		if (hint.root) ws = await workspaceForPath(ctx, hint.root);
		else if (local) ws = await workspaceForPath(ctx, local);
		else if (hint.change) ws = await workspaceForChange(ctx, hint.change);
		ws ??= await defaultWorkspace(ctx);
		if (!ws) throw new Error("None of this session's workspace roots is a Perforce client (or p4 is not configured).");
		return ws;
	}

	/** Pick a client for a command: the only one, or ask when the session has several. */
	async function chooseWorkspace(ctx: ExtensionContext, purpose: string): Promise<Workspace | null> {
		const all = await p4Workspaces(ctx);
		if (all.length <= 1 || !ctx.hasUI) return all[0] ?? (await defaultWorkspace(ctx));
		const labels = all.map(ws => `${ws.client}  (${ws.cwd})`);
		const picked = await ctx.ui.select(`Which Perforce client ${purpose}?`, labels);
		return all[labels.indexOf(picked ?? "")] ?? null;
	}

	async function refreshStatus(ctx: ExtensionContext): Promise<void> {
		const all = await p4Workspaces(ctx).catch(() => []);
		if (all.length === 0) return ctx.ui.setStatus("p4", undefined);
		const parts = await Promise.all(
			all.map(async ws => {
				// One fstat per client: opened files carry an `unresolved` flag.
				const files = await openedFiles(ws).catch(() => undefined);
				const unresolved = files?.filter(f => f.unresolved).length ?? 0;
				const count = files === undefined ? "?" : String(files.length);
				return `${ws.client} · ${count} open${unresolved ? ` · ${unresolved} to resolve` : ""}`;
			}),
		);
		ctx.ui.setStatus("p4", `p4 ${parts.join(" | ")}`);
		statusDirty = false;
	}

	/** Refresh p4:// completions in the background, at most every few minutes. */
	function maybeRefreshCompletions(all: Workspace[], force = false): void {
		if (all.length === 0 || (!force && Date.now() - completionsAt < COMPLETIONS_TTL_MS)) return;
		completionsAt = Date.now();
		void refreshCompletions(all).catch(() => {});
	}

	/** Show the p4 tools only while some session root is a Perforce client (roots can change with /add-dir). */
	async function syncToolVisibility(hasP4: boolean): Promise<void> {
		if (!hasP4 && !toolsHidden) {
			await pi.setActiveTools(pi.getActiveTools().filter(t => !P4_TOOLS.includes(t)));
			toolsHidden = true;
		} else if (hasP4 && toolsHidden) {
			await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...P4_TOOLS])]);
			toolsHidden = false;
		}
	}

	// ── Check-out on write ──────────────────────────────────────────────────

	pi.registerFileWriteFallback(async req => {
		const exists = await fs.stat(req.dst).then(
			s => s.isFile(),
			() => false,
		);
		if (!exists) return false; // a read-only *directory* is not a p4 problem
		const ws = await findWorkspace(path.dirname(req.dst));
		if (!ws || !p4OwnsPath(ws, req.dst)) return false; // not depot content, or inside a nested git repo
		try {
			const warnings = await openForEdit(ws, req.dst);
			statusDirty = true;
			if (warnings.length > 0) editNotes.set(req.dst, warnings);
		} catch (err) {
			editFailures.set(req.dst, errorText(err));
			return false;
		}
		editFailures.delete(req.dst);
		await Bun.write(req.dst, req.content);
		return true;
	});

	// Unix lets you unlink a read-only file, so this mostly fires on Windows.
	pi.registerFileDeleteFallback(async req => {
		if (!req.confirmedFile) return false;
		const ws = await findWorkspace(path.dirname(req.dst));
		if (!ws || !p4OwnsPath(ws, req.dst)) return false;
		try {
			await openForDelete(ws, req.dst);
			statusDirty = true;
			return true;
		} catch (err) {
			editFailures.set(req.dst, errorText(err));
			return false;
		}
	});

	// ── Queue what edit/write did, explain check-out results ────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const touched = touchedPaths(event, ctx.cwd);
		if (touched.length === 0) return;

		if (event.isError) {
			const reasons = touched.map(p => editFailures.get(p)).filter(Boolean);
			for (const p of touched) editFailures.delete(p);
			if (reasons.length === 0) return;
			return {
				additionalContext: `Perforce could not open the file for edit:\n${reasons.join("\n")}\nTell the user; do not chmod the file.`,
			};
		}
		// Paths in git roots (or nested git repos) are dropped here and left to git.
		for (const { ws, files } of (await groupByWorkspace(ctx, touched)).values()) {
			const queue = pendingReconcile.get(ws.client) ?? { ws, paths: new Set<string>() };
			for (const p of files) queue.paths.add(p);
			pendingReconcile.set(ws.client, queue);
		}

		const notes = touched.flatMap(p => editNotes.get(p) ?? []);
		for (const p of touched) editNotes.delete(p);
		if (notes.length === 0) return;
		return {
			additionalContext: `Perforce warnings when opening the file:\n${notes.join("\n")}\nA file that is not at the head revision must be synced and resolved before submit; mention this to the user.`,
		};
	});

	// ── Session wiring ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const all = await p4Workspaces(ctx);
		await syncToolVisibility(all.length > 0);
		if (all.length === 0) {
			const result = await p4(["info"], { cwd: ctx.cwd, timeoutMs: 10_000 }).catch(() => undefined);
			if (result && isLoginError(result)) notify(ctx, "Perforce ticket expired: run 'p4 login'.", "warning");
			if (result && isTrustError(result)) {
				notify(ctx, "Perforce is configured here, but the server's SSL fingerprint is not trusted yet: check it and run 'p4 trust'.", "warning");
			}
			return;
		}
		// Nothing here blocks the session from starting; the footer fills in when ready.
		void refreshStatus(ctx).catch(() => {});
		maybeRefreshCompletions(all, true);
		for (const ws of all) await syncIgnoreFile(ctx, ws);
	});

	/** Mirror P4IGNORE into `.ignore` so omp's grep/glob/find skip build outputs. */
	/**
	 * Keeps a generated .ignore in sync, and when there is none yet shows a footer
	 * tip pointing at `/p4 ignore` instead of interrupting startup with a dialog.
	 */
	async function syncIgnoreFile(ctx: ExtensionContext, ws: Workspace): Promise<void> {
		const state = await ignoreState(ws).catch(() => undefined);
		if (state?.kind === "stale") {
			await writeIgnore(state.source, state.target);
		} else if (state?.kind === "missing" && ctx.hasUI && ctx.agent?.kind !== "sub") {
			if (await wasDeclined(ignoreStateFile(), ws.root)) return;
			ctx.ui.setStatus("p4-tip", "tip: /p4 ignore makes search skip build outputs");
		}
	}

	const ignoreStateFile = () => path.join(pi.pi.getAgentDir(), "omp-p4.json");

	/** `/p4 ignore [off]`: create the generated .ignore for every client missing one, or dismiss the tip. */
	async function ignoreCommand(ctx: ExtensionContext, off: boolean): Promise<void> {
		const done: string[] = [];
		for (const ws of await p4Workspaces(ctx)) {
			const state = await ignoreState(ws);
			if (off) {
				await rememberDecline(ignoreStateFile(), ws.root);
			} else if (state.kind === "missing" || state.kind === "stale") {
				await writeIgnore(state.source, state.target);
				done.push(state.target);
			}
		}
		ctx.ui.setStatus("p4-tip", undefined);
		notify(
			ctx,
			off
				? "OK, no more tip. Run /p4 ignore any time to create it."
				: done.length
					? `Created ${done.join(", ")} from your P4IGNORE; search now skips what p4 ignores. Add \`.ignore\` to your P4IGNORE so p4 doesn't see the file.`
					: "Nothing to do: no P4IGNORE file at the client root, or a .ignore already exists.",
		);
	}

	pi.on("turn_end", async (_event, ctx) => {
		const problems = await flushReconcile();
		for (const problem of problems) notify(ctx, problem, "warning");
		if (statusDirty) void refreshStatus(ctx).catch(() => {});
		maybeRefreshCompletions(await p4Workspaces(ctx).catch(() => []));
	});

	// Bash: tell the agent about files a command changed without p4 knowing.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; cwd?: unknown };
		if (typeof input.command !== "string" || !mayWriteFiles(input.command)) return;
		const cwd = path.resolve(ctx.cwd, typeof input.cwd === "string" ? input.cwd : ".");
		const ws = await workspaceForPath(ctx, cwd).catch(() => null);
		if (!ws) return; // git root, untracked folder, or no Perforce here
		const queued = pendingReconcile.get(ws.client)?.paths ?? new Set<string>();
		const changes = (await unopenedChanges(ws, scanTargets(ws, input.command, cwd))).filter(c => !queued.has(c.localPath));
		if (changes.length === 0) return;
		const shown = changes.slice(0, 15).map(c => `  ${c.action.padEnd(7)} ${c.depotFile}`);
		if (changes.length > 15) shown.push(`  … and ${changes.length - 15} more`);
		return {
			additionalContext:
				`That command changed files Perforce does not know about yet:\n${shown.join("\n")}\n` +
				"If they belong in this change, open them with p4_reconcile. If they are build or tool outputs, leave them (they belong in P4IGNORE) and mention it to the user.",
		};
	});

	// p4 tools (shelve, resolve, unshelve, …) change what the footer shows.
	pi.on("tool_result", async event => {
		if (event.toolName.startsWith("p4_")) statusDirty = true;
	});

	/**
	 * Rewind snapshot, taken lazily: just before the first edit/write/bash of a
	 * prompt, keyed to that prompt's user message. Prompts that change nothing cost
	 * no p4 calls.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (snapshotTaken || ctx.agent?.kind === "sub") return;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;
		snapshotTaken = true;
		const all = await p4Workspaces(ctx).catch(() => []);
		if (all.length === 0) return;
		const branch = ctx.sessionManager.getBranch();
		const prompt = [...branch].reverse().find(e => {
			const entry = e as { type: string; message?: { role?: string } };
			return entry.type === "message" && entry.message?.role === "user";
		}) as { id: string } | undefined;
		if (!prompt) return;
		await flushReconcile();
		const taken = new Map<string, Snapshot>();
		for (const ws of all) {
			const snapshot = await takeSnapshot(ws).catch(() => undefined);
			if (snapshot) taken.set(ws.client, snapshot);
		}
		snapshots.set(prompt.id, taken);
	});

	pi.on("session_before_branch", async (event, ctx) => {
		if (event.reason !== "branch" || !ctx.hasUI) return;
		const byClient = snapshots.get(event.entryId);
		if (!byClient) return;
		await flushReconcile();
		const plans = [];
		for (const ws of await p4Workspaces(ctx)) {
			const snapshot = byClient.get(ws.client);
			if (!snapshot) continue;
			const plan = await planRestore(ws, snapshot);
			if (plan.revert.length > 0 || plan.rewrite.length > 0) plans.push({ ws, plan });
		}
		if (plans.length === 0) return;
		const listing = plans.map(({ ws, plan }) => describePlan(ws, plan)).join("\n");
		const choice = await ctx.ui.select(`Files changed since that message (${listing.split("\n").length}). Rewind them too?`, [
			"Restore files to that point",
			"Keep files as they are",
			"Show the files",
		]);
		if (choice === "Show the files") {
			const ok = await ctx.ui.confirm("Restore these files?", listing);
			if (!ok) return;
		} else if (choice !== "Restore files to that point") {
			return;
		}
		try {
			for (const { ws, plan } of plans) await applyRestore(ws, plan);
			notify(ctx, "Files restored to that point.", "info");
		} catch (err) {
			notify(ctx, `File restore failed part-way: ${errorText(err)}`, "error");
		}
		await refreshStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		snapshotTaken = false; // a new prompt gets its own snapshot on its first change
		const roots = await sessionRoots(ctx);
		const hasP4 = roots.some(r => r.kind === "p4");
		await syncToolVisibility(hasP4);
		// Roots can change between prompts (/add-dir), so replace any earlier note.
		const base = event.systemPrompt.filter(part => !part.includes(WORK_TAG));
		if (!hasP4) return base.length === event.systemPrompt.length ? undefined : { systemPrompt: base };
		return { systemPrompt: [...base, systemNote(roots)] };
	});

	// ── Tools ───────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "p4_opened",
		label: "P4 Opened",
		...renderers.opened,
		description: "List files opened in Perforce: the agent's work changelist by default, or every changelist; covers every Perforce root of the session.",
		parameters: type({
			"all?": type("boolean").describe("include files opened in any changelist (default: work changelist only)"),
		}),
		approval: "read",
		async execute(_id, params: { all?: boolean }, _signal, _onUpdate, ctx) {
			await ready(ctx);
			const all = await p4Workspaces(ctx);
			const sections: string[] = [];
			const files = [];
			for (const ws of all) {
				const work = params.all ? undefined : await existingWorkChange(ws);
				const opened = params.all || work ? await openedFiles(ws, work) : [];
				files.push(...opened);
				const lines = opened.map(f => `${f.action.padEnd(12)} ${f.depotFile}  (change ${f.change}, ${f.type})`);
				const body = lines.join("\n") || "(no opened files)";
				sections.push(all.length > 1 ? `## ${ws.client} (${ws.cwd})\n${body}` : body);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { files } };
		},
	});

	pi.registerTool({
		name: "p4_diff",
		label: "P4 Diff",
		...renderers.diff,
		description: "Unified diff of opened files against their have-revision. Adds and deletes are shown in full.",
		parameters: type({
			files: type("string").array().atLeastLength(1).atMostLength(10).describe("local or depot paths of opened files"),
		}),
		approval: "read",
		async execute(_id, params: { files: string[] }, _signal, _onUpdate, ctx) {
			await ready(ctx);
			const wanted = params.files.map(f => (isDepotPath(f) ? f : canonical(path.resolve(ctx.cwd, f))));
			const parts: string[] = [];
			const truncated: string[] = [];
			const found = new Set<string>();
			for (const ws of await p4Workspaces(ctx)) {
				const selected = (await openedFiles(ws)).filter(f => wanted.includes(f.depotFile) || wanted.includes(f.localPath));
				if (selected.length === 0) continue;
				for (const f of selected) found.add(f.depotFile).add(f.localPath);
				const rendered = await renderDiffs(ws, selected, { maxChars: DIFF_TOOL_BUDGET_CHARS, full: true });
				parts.push(rendered.text);
				truncated.push(...rendered.truncated);
			}
			const notOpened = wanted.filter(w => !found.has(w));
			const notes = notOpened.length ? `\n\n(not opened in Perforce: ${notOpened.join(", ")})` : "";
			return { content: [{ type: "text", text: (parts.join("\n\n") || "(no diff)") + notes }], details: { truncated } };
		},
	});

	pi.registerTool({
		name: "p4_changes",
		label: "P4 Changes",
		description: "Recent submitted changelists (with full descriptions) touching a path. Use for history and description style.",
		parameters: type({
			"path?": type("string").describe("local or depot path, wildcards allowed (default: current directory/...)"),
			"max?": type("1 <= number.integer <= 50").describe("how many changelists (default 10)"),
		}),
		approval: "read",
		async execute(_id, params: { path?: string; max?: number }, _signal, _onUpdate, ctx) {
			const ws = await ready(ctx, { paths: params.path ? [params.path] : [] });
			const target = params.path ?? `${ws.cwd}/...`;
			const { records } = await p4Strict(["changes", "-s", "submitted", "-l", "-m", String(params.max ?? 10), target], {
				cwd: ws.cwd,
			});
			const text = records.length
				? records.map(r => `Change ${r.change} by ${r.user} on ${formatTime(r.time)}\n${r.desc?.trim()}`).join("\n\n")
				: "(no changelists)";
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "p4_describe",
		label: "P4 Describe",
		description: "Show a changelist's description, files and (optionally) its diff. Works for submitted and shelved changes.",
		parameters: type({
			change: type("string").describe("changelist number"),
			"diff?": type("boolean").describe("include the unified diff (default false)"),
			"shelved?": type("boolean").describe("describe the shelved files of a pending changelist"),
		}),
		approval: "read",
		async execute(_id, params: { change: string; diff?: boolean; shelved?: boolean }, _signal, _onUpdate, ctx) {
			if (!/^\d+$/.test(params.change)) throw new Error(`Not a changelist number: ${params.change}`);
			const ws = await ready(ctx);
			const args = ["describe", params.diff ? "-du" : "-s", ...(params.shelved ? ["-S"] : []), params.change];
			const result = await p4(args, { cwd: ws.cwd, tagged: false });
			if (result.errors.length) throw new P4Error(result.errors.join("\n"), result);
			const text = result.stdout.length > DIFF_TOOL_BUDGET_CHARS
				? `${result.stdout.slice(0, DIFF_TOOL_BUDGET_CHARS)}\n[…${result.stdout.length - DIFF_TOOL_BUDGET_CHARS} chars elided…]`
				: result.stdout;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "p4_reconcile",
		label: "P4 Reconcile",
		description:
			"Open files you created, deleted, renamed or modified outside the edit/write tools (bash, generators) in the work changelist. Pass the paths or directories you touched.",
		parameters: type({
			paths: type("string").array().atLeastLength(1).describe("files, or directories (use dir/... for recursive)"),
			"preview?": type("boolean").describe("only list what would be opened"),
		}),
		approval: "write",
		async execute(_id, params: { paths: string[]; preview?: boolean }, _signal, _onUpdate, ctx) {
			await ready(ctx);
			const local = params.paths.filter(p => !isDepotPath(p)).map(p => p.replace(/\/\.\.\.$/, ""));
			const groups = [...(await groupByWorkspace(ctx, local)).values()];
			const depot = params.paths.filter(isDepotPath);
			if (depot.length > 0) groups.push({ ws: await ready(ctx), files: depot });
			// Keep the recursive `/...` suffix the caller asked for.
			const recursive = new Set(params.paths.filter(p => p.endsWith("/...")).map(p => canonical(path.resolve(ctx.cwd, p.slice(0, -4)))));
			const lines: string[] = [];
			const entries = [];
			for (const { ws, files } of groups) {
				const targets = files.map(f => (recursive.has(f) ? `${f}/...` : f));
				const result = await reconcile(ws, targets, { preview: params.preview });
				entries.push(...result.entries);
				lines.push(...result.entries.map(e => `${e.action.padEnd(12)} ${e.depotFile}`), ...result.warnings);
			}
			const skipped = local.length - groups.reduce((n, g) => n + g.files.filter(f => !isDepotPath(f)).length, 0);
			if (skipped > 0) lines.push(`(${skipped} path(s) are not Perforce-managed, e.g. in a git root; left alone)`);
			await refreshStatus(ctx);
			return { content: [{ type: "text", text: lines.join("\n") || "(nothing to reconcile)" }], details: { entries } };
		},
	});

	pi.registerTool({
		name: "p4_shelve",
		label: "P4 Shelve",
		description: [
			"Shelve every file opened in a numbered pending changelist, replacing its previous shelf. Refuses while files still need resolving or contain conflict markers.",
			"Reviews are started the team's way: review=true adds #review to the description so P4 Code Review opens a new review when the change is shelved; review=<id> adds #review-<id> to put the change into that existing review.",
			"Re-shelving a change already in a review updates it.",
		].join(" "),
		parameters: type({
			change: type("string").describe("pending changelist number (not the default changelist)"),
			"review?": type("boolean | number.integer").describe("true: start a review (#review); <id>: add to review <id> (#review-<id>)"),
		}),
		approval: "write",
		async execute(_id, params: { change: string; review?: boolean | number }, _signal, _onUpdate, ctx) {
			if (!/^\d+$/.test(params.change)) throw new Error(`Not a changelist number: ${params.change}`);
			const ws = await ready(ctx, { change: params.change });
			const files = await openedFiles(ws, params.change);
			if (files.length === 0) throw new Error(`Nothing is opened in changelist ${params.change}.`);
			const problems = await readinessProblems(ws, files);
			if (problems.length > 0) throw new Error(`Not shelving ${params.change}:\n${problems.join("\n")}`);
			const description =
				params.review === true || typeof params.review === "number"
					? await ensureReviewKeyword(ws, params.change, params.review)
					: await changeDescription(ws, params.change);
			const shelved = await shelve(ws, params.change);
			const lines = [`Shelved changelist ${params.change}:`, shelved.join("\n") || files.map(f => f.depotFile).join("\n")];
			if (hasReviewKeyword(description)) {
				const review = await waitForReview(ws, Number(params.change)).catch(() => undefined);
				lines.push(
					review
						? `Review ${review.id} (${review.state}) includes this change: p4://review/${review.id}`
						: "The description has a #review keyword, but the review server has not picked it up yet; check p4://review later or ask the user.",
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "p4_unshelve",
		label: "P4 Unshelve",
		description:
			"Bring a shelved changelist (yours or a colleague's review) into the work changelist. Files you already have open are scheduled for resolve; follow up with p4_resolve.",
		parameters: type({
			change: type("string").describe("shelved changelist number"),
			"files?": type("string").array().describe("only these files (depot or local paths; default: all)"),
			"root?": type("string").describe("session root (Perforce client) to unshelve into; default: the current one"),
		}),
		approval: "write",
		async execute(_id, params: { change: string; files?: string[]; root?: string }, _signal, _onUpdate, ctx) {
			if (!/^\d+$/.test(params.change)) throw new Error(`Not a changelist number: ${params.change}`);
			const ws = await ready(ctx, { root: params.root, paths: params.files });
			const files = (params.files ?? []).map(f => (isDepotPath(f) ? f : path.resolve(ctx.cwd, f)));
			const { opened, warnings } = await unshelve(ws, params.change, files);
			const pending = await pendingResolves(ws);
			await refreshStatus(ctx);
			const lines = [opened.join("\n") || "(nothing unshelved)", ...warnings];
			if (pending.length > 0) lines.push(`\n${pending.length} file(s) need resolving; run p4_resolve with action "auto" next.`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { pending } };
		},
	});

	pi.registerTool({
		name: "p4_resolve",
		label: "P4 Resolve",
		...renderers.resolve,
		description: [
			"Resolve files scheduled by sync, unshelve or integrate.",
			"status: list pending resolves and files with leftover conflict markers.",
			"auto: accept clean merges only (p4 resolve -am); real conflicts stay pending.",
			"markers: accept the merge with git-style diff3 conflict markers written into the file; then read the file and resolve every conflict://<id> region it reports.",
			"theirs / yours: take one side whole (for binary, filetype, move or delete resolves, or when one side is clearly right).",
			"redo: re-resolve files already resolved but not submitted.",
		].join(" "),
		parameters: type({
			action: type("'status' | 'auto' | 'markers' | 'theirs' | 'yours'"),
			"files?": type("string").array().describe("limit to these files (default: everything pending)"),
			"redo?": type("boolean").describe("re-resolve already resolved files (p4 resolve -f)"),
		}),
		approval: (args: unknown) => ((args as { action?: string })?.action === "status" ? "read" : "write"),
		async execute(
			_id,
			params: { action: "status" | ResolveMode; files?: string[]; redo?: boolean },
			_signal,
			_onUpdate,
			ctx,
		) {
			await ready(ctx);
			const targets = params.files?.length
				? [...(await groupByWorkspace(ctx, params.files)).values()]
				: (await p4Workspaces(ctx)).map(ws => ({ ws, files: [] as string[] }));
			const lines: string[] = [];
			const allPending = [];
			const allMarkers: string[] = [];
			for (const { ws, files } of targets) {
				if (params.action !== "status") {
					const { lines: done, warnings } = await resolve(ws, params.action, files, params.redo);
					lines.push(...done, ...warnings.filter(w => !/no file\(s\) to resolve/i.test(w)));
					if (params.action === "markers") {
						const converted = await convertMarkersToGit(await openedFiles(ws));
						if (converted.length) {
							lines.push(
								`Conflict markers written to:\n  ${converted.join("\n  ")}`,
								"Read each file: the read output lists conflict://<id> regions. Resolve each with write path conflict://<id>, using merged code or the @ours/@theirs/@base/@both line tokens (ours = YOURS, theirs = the incoming revision or shelf).",
							);
						}
					}
				}
				allPending.push(...(await pendingResolves(ws, files)));
				allMarkers.push(...(await readinessProblems(ws, await openedFiles(ws))).filter(p => p.startsWith("conflict markers")));
			}
			lines.push(
				allPending.length
					? `Still pending:\n${allPending.map(r => `  ${r.resolveType.padEnd(10)} ${r.localPath}  ← ${r.fromFile}${r.revRange}`).join("\n")}`
					: "No resolves pending.",
			);
			if (allMarkers.length) lines.push(`Edit these until no markers remain:\n  ${allMarkers.join("\n  ")}`);
			await refreshStatus(ctx);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { pending: allPending, markers: allMarkers } };
		},
	});

	// ── P4 Code Review (formerly Swarm) ─────────────────────────────────────

	const reviewRef = type("string").describe("review id, or a changelist number in the review");
	const reviewNumber = (value: string) => {
		if (!/^\d+$/.test(value)) throw new Error(`Not a review or changelist number: ${value}`);
		return Number(value);
	};

	pi.registerTool({
		name: "p4_review_comments",
		label: "P4 Review Comments",
		...renderers.review,
		description:
			"Read a P4 Code Review (Swarm) review: state, votes and comments with file:line, open tasks first, replies threaded.",
		parameters: type({ review: reviewRef, "open_only?": type("boolean").describe("only open tasks") }),
		approval: "read",
		async execute(_id, params: { review: string; open_only?: boolean }, _signal, _onUpdate, ctx) {
			const ws = await ready(ctx);
			const review = await resolveReview(ws, reviewNumber(params.review));
			const comments = await getComments(ws, review.id);
			return { content: [{ type: "text", text: formatComments(review, comments, params.open_only ?? false) }], details: { review } };
		},
	});

	pi.registerTool({
		name: "p4_review_reply",
		label: "P4 Review Reply",
		description:
			"Post to a P4 Code Review review as the user: reply to a comment (parent), comment on a file line, or add a general comment. Keep replies short and factual.",
		parameters: type({
			review: reviewRef,
			body: "string",
			"parent?": type("number.integer").describe("comment id to reply to"),
			"file?": type("string").describe("depot path for an inline comment"),
			"line?": type("number.integer").describe("line in the new version of file"),
			"task?": type("boolean").describe("make it an open task for the author"),
		}),
		approval: "write",
		async execute(
			_id,
			params: { review: string; body: string; parent?: number; file?: string; line?: number; task?: boolean },
			_signal,
			_onUpdate,
			ctx,
		) {
			const ws = await ready(ctx);
			const review = await resolveReview(ws, reviewNumber(params.review));
			const id = await postComment(ws, review.id, params.body, params);
			return { content: [{ type: "text", text: `Posted comment #${id} on review ${review.id}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "p4_review_task",
		label: "P4 Review Task",
		description: "Mark a review task addressed after fixing it and re-shelving, or reopen it.",
		parameters: type({ comment: type("number.integer").describe("comment id"), state: type("'addressed' | 'open'") }),
		approval: "write",
		async execute(_id, params: { comment: number; state: "addressed" | "open" }, _signal, _onUpdate, ctx) {
			const ws = await ready(ctx);
			await setTaskState(ws, params.comment, params.state);
			return { content: [{ type: "text", text: `Task #${params.comment} is now ${params.state}.` }], details: undefined };
		},
	});

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("p4-change", {
		description: "Split the agent's work changelist into described pending changelists ([--single] [--shelve] [instructions])",
		handler: async (args, ctx) => {
			const ws = await chooseWorkspace(ctx, "should /p4-change work on");
			if (!ws) return notify(ctx, "No Perforce client among this session's roots.", "error");
			await flushReconcile();
			try {
				await runChangeCommand(ws, args, ctx);
			} catch (err) {
				notify(ctx, `/p4-change failed: ${errorText(err)}`, "error");
			} finally {
				await refreshStatus(ctx);
			}
		},
	});

	pi.registerCommand("p4", {
		description:
			"Show each root's version control and the work changelist; `/p4 ignore` makes search skip what P4IGNORE ignores (`/p4 ignore off` hides the tip)",
		getArgumentCompletions: (prefix: string) =>
			["ignore", "ignore off"].filter(o => o.startsWith(prefix.trim())).map(o => ({ value: o, label: o })),
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "ignore" || sub === "ignore off") return ignoreCommand(ctx, sub === "ignore off");
			await flushReconcile();
			const lines: string[] = [];
			for (const root of await sessionRoots(ctx)) {
				if (root.kind !== "p4" || !root.ws) {
					lines.push(`${root.dir}: ${root.kind === "git" ? `git (${root.gitRoot})` : "no version control"}`, "");
					continue;
				}
				const ws = root.ws;
				const work = await existingWorkChange(ws);
				const files = await openedFiles(ws);
				const mine = files.filter(f => f.change === work);
				lines.push(
					`${root.dir}: Perforce client ${ws.client} (${ws.user}@${ws.server}), root ${ws.root}`,
					work
						? `  work changelist ${work}: ${mine.length} file(s); ${files.length - mine.length} open elsewhere on this client`
						: `  no work changelist yet; ${files.length} file(s) open on this client`,
					...mine.map(f => `    ${f.action.padEnd(12)} ${f.depotFile}`),
					"",
				);
			}
			notify(ctx, lines.join("\n").trim(), "info");
		},
	});

	pi.registerCommand("p4-review", {
		description:
			"AI review of a Perforce diff: the work changelist, --all opened files, or a shelf/change number ([n] [--all] [--annotate] [focus])",
		handler: async (args, ctx) => {
			const change = args.split(/\s+/).find(t => /^\d+$/.test(t));
			const ws = change ? await workspaceForChange(ctx, change) : await chooseWorkspace(ctx, "should /p4-review look at");
			if (!ws) return notify(ctx, "No Perforce client among this session's roots.", "error");
			await flushReconcile();
			try {
				await runReviewCommand(ws, args, ctx);
			} catch (err) {
				notify(ctx, `/p4-review failed: ${errorText(err)}`, "error");
			}
		},
	});

	pi.registerCommand("p4-review-fix", {
		description: "Have the agent address the open tasks of a P4 Code Review review (<review id | change>)",
		handler: async (args, ctx) => {
			const ws = await defaultWorkspace(ctx);
			if (!ws) return notify(ctx, "No Perforce client among this session's roots.", "error");
			const ref = args.trim();
			if (!/^\d+$/.test(ref)) return notify(ctx, "Usage: /p4-review-fix <review id | changelist>", "error");
			try {
				const review = await resolveReview(ws, Number(ref));
				const comments = await getComments(ws, review.id);
				const open = comments.filter(c => c.taskState === "open" && !c.flags.includes("closed"));
				if (open.length === 0) return notify(ctx, `Review ${review.id} has no open tasks.`, "info");
				const change = review.changes.at(-1);
				pi.sendUserMessage(
					[
						`Address the ${open.length} open task(s) on P4 Code Review review ${review.id}${change ? ` (changelist ${change})` : ""}.`,
						"1. If the review's files are not open in this workspace, unshelve them with p4_unshelve and resolve anything that needs it.",
						"2. Fix each task. If you disagree with one, do not change the code; draft a reply and ask me first.",
						"3. Show me a short summary of the changes, then wait for my go-ahead before re-shelving with p4_shelve, marking tasks addressed with p4_review_task, or posting replies.",
						"",
						formatComments(review, comments, true),
					].join("\n"),
				);
			} catch (err) {
				notify(ctx, `/p4-review-fix failed: ${errorText(err)}`, "error");
			}
		},
	});

}

/** Absolute, symlink-resolved paths an edit/write call created, changed, moved or deleted. */
function touchedPaths(event: { toolName: string; input: Record<string, unknown>; details?: unknown }, cwd: string): string[] {
	const out = new Set<string>();
	const add = (p: unknown) => {
		if (typeof p !== "string" || !p) return;
		// Skip internal URIs (local://…) and archive members (foo.zip:entry); keep Windows drive paths.
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[^:]{2,}:/.test(p)) return;
		out.add(canonical(path.resolve(cwd, p)));
	};
	if (event.toolName === "write") {
		add(event.input.path);
	} else {
		const d = (event.details ?? {}) as {
			path?: string;
			move?: string;
			sourcePath?: string;
			perFileResults?: { path?: string; move?: string }[];
		};
		add(d.path);
		add(d.move);
		add(d.sourcePath);
		for (const r of d.perFileResults ?? []) {
			add(r.path);
			add(r.move);
		}
	}
	return [...out];
}

function formatTime(epoch: string | undefined): string {
	const seconds = Number(epoch);
	return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : "?";
}

function systemNote(roots: RootInfo[]): string {
	const p4Root = roots.find(r => r.kind === "p4")!;
	const where =
		roots.length > 1
			? [...describeRoots(roots), "Everything below applies to the Perforce roots only; work in git roots with git as usual."]
			: [`This directory is in Perforce client "${p4Root.ws!.client}" (root ${p4Root.ws!.root}). There is no git here; do not use git commands.`];
	return [
		`# Perforce workspace ${WORK_TAG}`,
		...where,
		"Depot files are read-only until opened. The edit and write tools open them for you (p4 edit/add/delete) in the agent's pending work changelist; never chmod files to make them writable.",
		"Files created or deleted by edit/write are opened in Perforce at the end of the turn. After bash commands that change files, you will be told what Perforce does not know about yet; open what belongs in the change with p4_reconcile.",
		"Review your changes with p4_opened and p4_diff. Use p4_changes and p4_describe for history. Read other branches, streams or old revisions with read p4://<depot path>#rev instead of syncing.",
		"Shelve for review with p4_shelve and bring shelves (including colleagues' reviews) into your work with p4_unshelve. When submitting from bash, always name the changelist (p4 submit -c <n>) and never submit the default changelist by accident.",
		"P4 Code Review (Swarm): reviews are started by shelving a change whose description has #review (p4_shelve with review=true), and a change joins an existing review with #review-<id> (review=<id>); re-shelving updates the review. Do this only when the user asks for a review. Read reviews with p4_review_comments; reply or mark tasks addressed only when the user asked, since posts appear under the user's name.",
		"Resolving: after sync, unshelve or integrate, run p4_resolve auto first. For remaining content conflicts run p4_resolve markers, read the files, and resolve each conflict://<id> region with write (ours = YOURS, theirs = the incoming revision or shelf), understanding both sides' intent (read the changelists with p4_describe if unsure). For binary, filetype, move or delete resolves pick theirs or yours and tell the user which. Finish with p4_resolve status showing nothing pending and no markers before shelving or submitting.",
	].join("\n");
}
