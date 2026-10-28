/**
 * `/p4-change`: turn the agent's work changelist into described, reviewable
 * pending changelists. Splits are per file, since Perforce cannot put hunks of
 * one file into different changelists. Never submits.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { renderDiffs } from "./diff";
import { p4 } from "./p4";
import { waitForReview } from "./review-server";
import { p4OwnsPath } from "./roots";
import {
	createChange,
	deleteChange,
	existingWorkChange,
	forgetWorkChange,
	type OpenedFile,
	openedFiles,
	readinessProblems,
	reconcile,
	reopen,
	shelve,
	withReviewKeyword,
	type Workspace,
} from "./workspace";

export interface PlannedChange {
	description: string;
	files: string[];
}

const DIFF_BUDGET_CHARS = 80_000;
const TEMPLATE_PATHS = [".omp/p4-description.md", ".p4-description.md"];

export async function runChangeCommand(ws: Workspace, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const flag = (name: string) => new RegExp(`(^|\\s)--${name}(?=\\s|$)`).test(args);
	const single = flag("single");
	// --review is the team flow: #review in each description, then shelve.
	const startReviews = flag("review");
	const shelveAfter = startReviews || flag("shelve");
	const hint = args.replace(/(^|\s)--(single|shelve|review)(?=\s|$)/g, " ").trim();
	await offerReconcile(ws, ctx);
	const work = await existingWorkChange(ws);
	if (!work) {
		ctx.ui.notify("The agent has not opened any files yet.", "info");
		return;
	}

	const files = await openedFiles(ws, work);
	if (files.length === 0) {
		ctx.ui.notify(`Nothing open in the work changelist ${work}.`, "info");
		return;
	}
	const problems = await readinessProblems(ws, files);
	if (problems.length > 0) {
		if (shelveAfter) {
			ctx.ui.notify(`Not shelving until these are fixed (p4_resolve can help):\n${problems.join("\n")}`, "error");
			return;
		}
		const go = await ctx.ui.confirm("Some files are not ready to submit. Create changelists anyway?", problems.join("\n"));
		if (!go) return;
	}
	if (!ctx.runEphemeralTurn) {
		ctx.ui.notify("This omp host cannot run side turns; use p4 change manually.", "error");
		return;
	}

	ctx.ui.setWorkingMessage?.("Drafting changelist descriptions…");
	let plan: PlannedChange[];
	try {
		const prompt = await buildPrompt(ws, files, { single, hint });
		const { replyText } = await ctx.runEphemeralTurn({ promptText: prompt, tools: false, dedupeReply: false, replyMaxBytes: 64_000 });
		plan = normalizePlan(parsePlan(replyText), files, single);
		if (startReviews) plan = plan.map(c => ({ ...c, description: withReviewKeyword(c.description, true) }));
	} finally {
		ctx.ui.setWorkingMessage?.();
	}

	const summary = plan
		.map((c, i) => `#${i + 1} (${c.files.length} file${c.files.length === 1 ? "" : "s"})\n${c.description}\n  ${c.files.join("\n  ")}`)
		.join("\n\n");
	const verb = startReviews ? "Create, shelve and start reviews for" : shelveAfter ? "Create and shelve" : "Create";
	const ok = await ctx.ui.confirm(`${verb} ${plan.length} pending changelist${plan.length === 1 ? "" : "s"}?`, summary);
	if (!ok) {
		ctx.ui.notify(`Kept everything in work changelist ${work}.`, "info");
		return;
	}

	const created: string[] = [];
	for (const change of plan) {
		const number = await createChange(ws, change.description);
		await reopen(ws, number, change.files);
		created.push(number);
	}
	if (shelveAfter) for (const number of created) await shelve(ws, number);
	const left = await openedFiles(ws, work);
	if (left.length === 0) {
		// p4 refuses to delete a changelist that still has shelved files; leave it and keep using it.
		try {
			await deleteChange(ws, work);
			forgetWorkChange(ws);
		} catch {}
	}
	const plural = created.length === 1 ? "" : "s";
	if (startReviews) {
		ctx.ui.setWorkingMessage?.("Waiting for P4 Code Review to pick up the shelves…");
		const reviews = await Promise.all(created.map(n => waitForReview(ws, Number(n)).catch(() => undefined)));
		ctx.ui.setWorkingMessage?.();
		const lines = created.map((n, i) =>
			reviews[i] ? `change ${n} → review ${reviews[i]!.id} (p4://review/${reviews[i]!.id})` : `change ${n} → shelved with #review; review not visible yet`,
		);
		ctx.ui.notify(`Shelved for review:\n${lines.join("\n")}\nRe-shelve with p4_shelve to update a review after fixes.`, "info");
		return;
	}
	ctx.ui.notify(
		shelveAfter
			? `Created and shelved changelist${plural} ${created.join(", ")} for review. Update a shelf after fixes with p4_shelve.`
			: `Created pending changelist${plural} ${created.join(", ")}. Review with 'p4 describe -du <n>', submit with 'p4 submit -c <n>'.`,
		"info",
	);
}

/** Show what bash or other tools changed outside p4 and offer to open it. */
async function offerReconcile(ws: Workspace, ctx: ExtensionCommandContext): Promise<void> {
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
		`${preview.entries.length} change${preview.entries.length === 1 ? "" : "s"} not yet opened in p4. Open them in the work changelist?`,
		list,
	);
	if (include) await reconcile(ws, preview.entries.map(e => e.localPath));
}

async function buildPrompt(ws: Workspace, files: OpenedFile[], options: { single: boolean; hint: string }): Promise<string> {
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
		"Write Perforce changelist descriptions for the files below, using what you know from this conversation about why they changed.",
		options.single
			? "Put every file in ONE changelist."
			: "Group the files into one or more changelists. Split only when the changes are clearly independent and each group stands on its own; every file goes in exactly one group. A file cannot be split across changelists.",
		"Reply with JSON only, no prose and no code fence:",
		'{"changelists":[{"description":"<summary line>\\n\\n<body>","files":["//depot/path", ...]}]}',
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
		const entry = c as { description?: unknown; files?: unknown };
		return {
			description: typeof entry.description === "string" ? entry.description : "",
			files: Array.isArray(entry.files) ? entry.files.filter((f): f is string => typeof f === "string") : [],
		};
	});
}

/**
 * Make the plan safe to apply: drop unknown paths and duplicates, put files the
 * model forgot into the first changelist, drop empty groups.
 */
export function normalizePlan(plan: PlannedChange[], files: OpenedFile[], single: boolean): PlannedChange[] {
	const known = new Set(files.map(f => f.depotFile));
	const seen = new Set<string>();
	let groups = plan
		.map(c => ({
			description: c.description.trim() || "Changes made with omp",
			files: c.files.filter(f => known.has(f) && !seen.has(f) && seen.add(f)),
		}))
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
