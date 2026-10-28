/**
 * Unified diffs for opened files, sized for model context.
 *
 * `p4 diff` only covers files opened for edit; adds and deletes are rendered
 * from the local file and the have-revision so every action yields a diff.
 * Prioritisation and truncation follow omp's own `git_file_diff` tool.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { p4 } from "./p4";
import type { OpenedFile, Workspace } from "./workspace";

const HIGH_PRIORITY_EXTENSIONS = new Set([
	".v",
	".sv",
	".svh",
	".vh",
	".vhd",
	".vhdl",
	".tcl",
	".sdc",
	".xdc",
	".upf",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".py",
	".rs",
	".go",
	".java",
	".js",
	".ts",
	".scala",
]);
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".csh", ".tcsh", ".pl", ".mk", ".make", ".f", ".flist"]);
const LOW_PRIORITY_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".rpt", ".log"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".so", ".a", ".o", ".gds", ".oas", ".db", ".lib"]);
const TEST_PATTERNS = ["/test/", "/tests/", "/tb/", "_tb.", "/sim/", "_test.", ".test."];

export function filePriority(file: string): number {
	const base = path.basename(file);
	const ext = path.extname(base).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return -100;
	const lower = file.toLowerCase();
	if (TEST_PATTERNS.some(p => lower.includes(p))) return 10;
	if (LOW_PRIORITY_EXTENSIONS.has(ext)) return 20;
	if (base === "Makefile" || SCRIPT_EXTENSIONS.has(ext)) return 80;
	if (HIGH_PRIORITY_EXTENSIONS.has(ext)) return 100;
	return 50;
}

/**
 * Unified diff for one opened file. Headers are git-style (`diff --git a/… b/…`)
 * so omp's review and annotate pipelines can split the result per file.
 */
export async function diffOpenedFile(ws: Workspace, file: OpenedFile): Promise<string> {
	const rel = path.relative(ws.root, file.localPath);
	if (file.action.endsWith("add") || file.action === "branch") {
		const text = await fs.readFile(file.localPath, "utf8").catch(() => undefined);
		return added(rel, text);
	}
	if (file.action.endsWith("delete")) {
		const { stdout } = await p4(["print", "-q", `${file.depotFile}#have`], { cwd: ws.cwd, tagged: false });
		return deleted(rel, stdout);
	}
	const { stdout } = await p4(["diff", "-du", file.localPath], { cwd: ws.cwd, tagged: false });
	return modified(rel, stdout);
}

export interface ChangeFile {
	depotFile: string;
	action: string;
	rev: string;
	type: string;
}

/** Files of a submitted or shelved changelist, from `p4 describe -s [-S]`. */
export async function changeFiles(ws: Workspace, change: string, shelved: boolean): Promise<{ files: ChangeFile[]; desc: string; user: string }> {
	const result = await p4(["describe", "-s", ...(shelved ? ["-S"] : []), change], { cwd: ws.cwd });
	const rec = result.records[0];
	if (result.errors.length > 0 || !rec?.change) {
		throw new Error(`p4 describe ${change}: ${[...result.errors, ...result.warnings].join("; ") || "no such changelist"}`);
	}
	const files: ChangeFile[] = [];
	for (let i = 0; rec[`depotFile${i}`]; i++) {
		files.push({ depotFile: rec[`depotFile${i}`], action: rec[`action${i}`], rev: rec[`rev${i}`], type: rec[`type${i}`] ?? "text" });
	}
	return { files, desc: rec.desc ?? "", user: rec.user ?? "" };
}

/**
 * Diff one file of a changelist. Shelved files are compared against the revision
 * they were shelved from (`#rev` → `@=change`); submitted ones against `#rev-1`.
 */
export async function diffChangeFile(ws: Workspace, change: string, file: ChangeFile, shelved: boolean): Promise<string> {
	const rel = file.depotFile.replace(/^\/\//, "");
	if (/binary|apple|resource/.test(file.type)) return `diff --git a/${rel} b/${rel}\n(binary ${file.action})`;
	const rev = Number(file.rev);
	const after = shelved ? `${file.depotFile}@=${change}` : `${file.depotFile}#${rev}`;
	const before = shelved ? `${file.depotFile}#${rev}` : `${file.depotFile}#${rev - 1}`;
	const print = async (spec: string) => (await p4(["print", "-q", spec], { cwd: ws.cwd, tagged: false })).stdout;
	if (file.action.endsWith("add") || file.action === "branch" || (!shelved && rev <= 1)) return added(rel, await print(after));
	if (file.action.endsWith("delete")) return deleted(rel, await print(before));
	const { stdout } = await p4(["diff2", "-du", before, after], { cwd: ws.cwd, tagged: false });
	return modified(rel, stdout);
}

function added(rel: string, text: string | undefined): string {
	const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
	if (text === undefined) return `${head}(unreadable)`;
	if (text.includes("\0")) return `${head}(binary file added)`;
	return head + wholeFile("+", "/dev/null", `b/${rel}`, text);
}

function deleted(rel: string, text: string): string {
	const head = `diff --git a/${rel} b/${rel}\ndeleted file mode 100644\n`;
	if (text.includes("\0")) return `${head}(binary file deleted)`;
	return head + wholeFile("-", `a/${rel}`, "/dev/null", text);
}

/** Rebuild headers around p4's own `diff`/`diff2 -du` output, keeping only the hunks. */
function modified(rel: string, p4Output: string): string {
	const head = `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}`;
	const start = p4Output.indexOf("\n@@");
	if (start < 0) {
		const note = p4Output.trim().split("\n").slice(1).join("\n").trim();
		return `${head}\n${note || "(no content change)"}`;
	}
	return `${head}${p4Output.slice(start)}`.trimEnd();
}

function wholeFile(sign: "+" | "-", from: string, to: string, text: string): string {
	const lines = text.replace(/\n$/, "").split("\n");
	const range = sign === "+" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
	return `--- ${from}\n+++ ${to}\n@@ ${range} @@\n${lines.map(l => sign + l).join("\n")}`;
}

const TRUNCATE_THRESHOLD_LINES = 30;
const KEEP_HEAD_LINES = 15;
const KEEP_TAIL_LINES = 10;

function truncate(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= TRUNCATE_THRESHOLD_LINES) return diff;
	const elided = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
	return [...lines.slice(0, KEEP_HEAD_LINES), `[…${elided} lines elided…]`, ...lines.slice(-KEEP_TAIL_LINES)].join("\n");
}

/**
 * Render diffs for `files` within `maxChars`, highest-priority files first.
 * With `full`, a file is only cut when it alone would overflow the budget.
 */
export async function renderDiffs(
	ws: Workspace,
	files: OpenedFile[],
	options: { maxChars: number; full?: boolean },
): Promise<{ text: string; truncated: string[] }> {
	const sorted = [...files].sort((a, b) => filePriority(b.localPath) - filePriority(a.localPath));
	const parts: string[] = [];
	const truncated: string[] = [];
	let used = 0;
	for (const file of sorted) {
		const remaining = options.maxChars - used;
		if (remaining <= 0) {
			truncated.push(file.depotFile);
			continue;
		}
		let diff = await diffOpenedFile(ws, file);
		if (!options.full || diff.length > remaining) {
			const cut = truncate(diff);
			if (cut !== diff) truncated.push(file.depotFile);
			diff = cut;
		}
		if (diff.length > remaining) {
			diff = `${diff.slice(0, remaining)}\n[…${diff.length - remaining} chars elided…]`;
			if (!truncated.includes(file.depotFile)) truncated.push(file.depotFile);
		}
		const part = `=== ${file.depotFile} (${file.action}) ===\n${diff}`;
		parts.push(part);
		used += part.length;
	}
	return { text: parts.join("\n\n"), truncated };
}
