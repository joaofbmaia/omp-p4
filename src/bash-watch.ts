/**
 * Notice files a bash command changed behind Perforce's back.
 *
 * Bash runs constantly (grep, ls, builds), so this stays cheap: only commands
 * that look like they write files trigger a check, and the check is a
 * `p4 reconcile -n` preview of the command's directory (non-recursive) plus the
 * paths the command names, with a short timeout. Nothing is opened: the agent
 * is told, and decides (build outputs belong in P4IGNORE, not the changelist).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { p4 } from "./p4";
import { canonical, p4OwnsPath } from "./roots";
import { isUnder, type ReconcileEntry, type Workspace } from "./workspace";

const WRITES =
	/(^|[\s;&|(`])(>|>>|\d>|tee\b|mv\b|cp\b|rm\b|rmdir\b|mkdir\b|touch\b|ln\b|install\b|rsync\b|tar\b|unzip\b|patch\b|sed\s+(-\w*i|--in-place)|perl\s+-\w*i|truncate\b|dd\b|make\b|cmake\b|ninja\b|python3?\b|perl\b|ruby\b|node\b|bun\b|npm\b|tclsh\b|\.\/|[\w.-]+\.(sh|py|pl|tcl)\b)/;

/** Whether `command` plausibly writes files (cheap pre-filter before asking p4). */
export function mayWriteFiles(command: string): boolean {
	return WRITES.test(command);
}

/** Paths a command names that exist in (or would be created in) the workspace, as p4 file specs. */
export function scanTargets(ws: Workspace, command: string, cwd: string, max = 20): string[] {
	const targets = new Set<string>();
	if (p4OwnsPath(ws, path.join(cwd, "x"))) targets.add(path.join(canonical(cwd), "*"));
	for (const raw of command.split(/[\s;&|()<>`'"=]+/)) {
		if (!raw || raw.startsWith("-") || !/[/.]/.test(raw) || /[*?$[\]{}]/.test(raw)) continue;
		const abs = canonical(path.resolve(cwd, raw));
		if (!isUnder(abs, ws.root) || !p4OwnsPath(ws, abs)) continue;
		const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
		targets.add(isDir ? path.join(abs, "...") : abs);
		if (targets.size >= max) break;
	}
	return [...targets];
}

/** Files under `targets` that changed without p4 knowing (adds, edits of unopened files, deletes). */
export async function unopenedChanges(ws: Workspace, targets: string[], timeoutMs = 5_000): Promise<ReconcileEntry[]> {
	if (targets.length === 0) return [];
	const result = await p4(["reconcile", "-n", ...targets], { cwd: ws.cwd, timeoutMs }).catch(() => undefined);
	if (!result) return [];
	// Overlapping targets (a folder and a file in it) report the same file twice.
	const byDepotFile = new Map<string, ReconcileEntry>();
	for (const r of result.records) {
		if (!r.depotFile || !r.action || !r.clientFile || !p4OwnsPath(ws, r.clientFile)) continue;
		if (r.clientFile.endsWith(`${path.sep}.ignore`)) continue;
		byDepotFile.set(r.depotFile, { depotFile: r.depotFile, localPath: r.clientFile, action: r.action });
	}
	return [...byDepotFile.values()];
}
