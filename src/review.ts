/**
 * `/p4-review`: run omp's code-review pipeline, or its annotation overlay, on
 * a Perforce diff — the agent's work changelist, a shelf or a submitted change.
 */
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { changeFiles, diffChangeFile, diffOpenedFile, filePriority } from "./diff";
import { p4 } from "./p4";
import { findReviewForChange, formatComments, getComments } from "./review-server";
import { existingWorkChange, openedFiles, type Workspace } from "./workspace";

/** omp rejects LLM review requests above these. */
const MAX_REVIEW_CHARS = 50_000;
const MAX_REVIEW_FILES = 20;

export interface Piece {
	name: string;
	diff: string;
}

export async function runReviewCommand(ws: Workspace, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const annotate = tokens.includes("--annotate");
	const all = tokens.includes("--all");
	const change = tokens.find(t => /^\d+$/.test(t));
	const focus = tokens.filter(t => t !== "--annotate" && t !== "--all" && t !== change).join(" ");

	ctx.ui.setWorkingMessage("Collecting the diff…");
	let pieces: Piece[];
	let label: string;
	let reviewerContext = "";
	try {
		if (change) {
			({ pieces, label } = await changeDiff(ws, change));
			if (pieces.length === 0) return ctx.ui.notify(`${label}: no files to review.`, "warning");
			reviewerContext = await existingReviewComments(ws, Number(change));
		} else {
			const work = all ? undefined : await existingWorkChange(ws);
			const opened = all || work ? await openedFiles(ws, work) : [];
			if (opened.length === 0) return ctx.ui.notify("Nothing opened to review.", "info");
			pieces = await Promise.all(opened.map(async f => ({ name: f.depotFile, diff: await diffOpenedFile(ws, f) })));
			label = all ? `All opened files on ${ws.client}` : "Agent work changelist";
		}
	} finally {
		ctx.ui.setWorkingMessage();
	}

	if (annotate) {
		if (ctx.mode !== "tui") return ctx.ui.notify("--annotate needs the interactive TUI.", "error");
		await ctx.annotations.open({ source: { kind: "diff", diff: joinDiffs(pieces), label }, focus: focus || undefined });
		return;
	}

	const { kept, dropped } = fitForReview(pieces);
	if (dropped.length > 0) {
		const go = await ctx.ui.confirm(
			`Diff too large for one review; reviewing the ${kept.length} highest-priority files. Continue?`,
			`Left out:\n${dropped.join("\n")}\n\nRun /p4-review again with focus text to steer it, or --annotate to read everything.`,
		);
		if (!go) return;
	}
	const focusText = [focus, reviewerContext].filter(Boolean).join("\n\n") || undefined;
	await ctx.annotations.submit({
		source: { kind: "diff", diff: joinDiffs(kept), label },
		notes: [],
		review: true,
		focus: focusText,
	});
}

/**
 * Per-file diffs of a changelist: its shelf when pending (or its opened files
 * when it is an unshelved pending change on this client), its submitted
 * revisions otherwise.
 */
export async function changeDiff(ws: Workspace, change: string): Promise<{ pieces: Piece[]; label: string }> {
	const kind = await changeKind(ws, change);
	if (kind === "pending") {
		const opened = await openedFiles(ws, change);
		const pieces = await Promise.all(opened.map(async f => ({ name: f.depotFile, diff: await diffOpenedFile(ws, f) })));
		return { pieces, label: `Pending change ${change} (opened files, not shelved)` };
	}
	const shelved = kind === "shelf";
	const { files, user, desc } = await changeFiles(ws, change, shelved);
	const pieces = await Promise.all(files.map(async f => ({ name: f.depotFile, diff: await diffChangeFile(ws, change, f, shelved) })));
	return { pieces, label: `${shelved ? "Shelf" : "Change"} ${change} by ${user}: ${desc.trim().split("\n")[0]}` };
}

async function changeKind(ws: Workspace, change: string): Promise<"shelf" | "pending" | "submitted"> {
	const { records, errors, warnings } = await p4(["describe", "-s", "-S", change], { cwd: ws.cwd });
	// "no such changelist" is only a warning in p4, so check for the record itself.
	if (errors.length > 0 || !records[0]?.change) {
		throw new Error(`p4 describe ${change}: ${[...errors, ...warnings].join("; ") || "no such changelist"}`);
	}
	if (records[0].status !== "pending") return "submitted";
	return records[0]?.depotFile0 ? "shelf" : "pending";
}

async function existingReviewComments(ws: Workspace, change: number): Promise<string> {
	try {
		const review = await findReviewForChange(ws, change);
		if (!review) return "";
		const comments = await getComments(ws, review.id);
		if (comments.length === 0) return "";
		return `Existing reviewer discussion (do not repeat points already raised):\n${formatComments(review, comments, false)}`;
	} catch {
		return ""; // no review server, or not reachable: review the diff alone
	}
}

export function joinDiffs(pieces: Piece[]): string {
	return `${pieces.map(p => p.diff).join("\n")}\n`;
}

/** Highest-priority files first, within omp's review size limits. */
export function fitForReview(pieces: Piece[]): { kept: Piece[]; dropped: string[] } {
	const sorted = [...pieces].sort((a, b) => filePriority(b.name) - filePriority(a.name));
	const kept: Piece[] = [];
	const dropped: string[] = [];
	let size = 0;
	for (const piece of sorted) {
		if (kept.length < MAX_REVIEW_FILES && size + piece.diff.length + 1 <= MAX_REVIEW_CHARS) {
			kept.push(piece);
			size += piece.diff.length + 1;
		} else {
			dropped.push(piece.name);
		}
	}
	return { kept: kept.sort((a, b) => a.name.localeCompare(b.name)), dropped };
}
