/**
 * Perforce workspace discovery and the p4 operations the extension runs.
 *
 * Every operation that opens files takes the pending changelist to open them in;
 * which changelist that is (yours, or one the agent created) is decided in
 * changes.ts.
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { hasGitMarkers, hasP4Markers, p4MarkersToGit } from "./markers";
import { isLoginError, isTrustError, P4Error, p4, p4Strict } from "./p4";

/** Marks the extension's part of the system prompt, so it can be replaced each prompt. */
export const NOTE_TAG = "[omp-p4]";

export interface Workspace {
	client: string;
	user: string;
	server: string;
	/** Realpath'd client root. */
	root: string;
	/** Directory p4 commands run from (inside `root`, so P4CONFIG resolves). */
	cwd: string;
}

export interface OpenedFile {
	depotFile: string;
	/** Local path. */
	localPath: string;
	action: string;
	change: string;
	type: string;
	/** For move/add and move/delete: the other side of the move. */
	movedFile?: string;
	/** A resolve is still pending (sync, unshelve, integrate). */
	unresolved?: boolean;
}

/**
 * `p4 info` answers per directory. Hits are kept; "not a Perforce client" is kept
 * for a few minutes (a git repo is asked once, not on every tool call), and a
 * failure (server slow or down, ticket expired) is retried after a short pause.
 */
const workspaceCache = new Map<string, { pending: Promise<Workspace | null>; expires: number }>();
const NOT_A_CLIENT_TTL_MS = 5 * 60_000;
const RETRY_AFTER_MS = 30_000;

/** Workspaces detected so far, to answer subdirectories without another `p4 info`. */
const knownWorkspaces: Workspace[] = [];

/**
 * A known workspace covering `dir` without asking the server: `dir` must be at or
 * below the directory the workspace was detected from, with no other P4CONFIG
 * file in between that could select a different client.
 */
function knownWorkspaceFor(dir: string): Workspace | undefined {
	const configName = process.env.P4CONFIG;
	for (const ws of knownWorkspaces) {
		if (!isUnder(dir, ws.cwd)) continue;
		let current = dir;
		let shadowed = false;
		while (current !== ws.cwd && configName) {
			if (fsSync.existsSync(path.join(current, configName))) {
				shadowed = true;
				break;
			}
			current = path.dirname(current);
		}
		if (!shadowed) return ws;
	}
	return undefined;
}

/** Discover the Perforce client owning `dir`; `null` when p4 is missing, unconfigured or `dir` is outside the root. */
export function findWorkspace(dir: string): Promise<Workspace | null> {
	const known = knownWorkspaceFor(fsRealpath(dir));
	if (known) return Promise.resolve(known);
	const cached = workspaceCache.get(dir);
	if (cached && Date.now() < cached.expires) return cached.pending;
	const entry = { pending: detect(dir).then(({ ws, failed }) => {
		entry.expires = ws ? Infinity : failed === undefined ? 0 : Date.now() + (failed ? RETRY_AFTER_MS : NOT_A_CLIENT_TTL_MS);
		return ws;
	}), expires: Infinity };
	workspaceCache.set(dir, entry);
	return entry.pending;
}

/** `failed`: true for no answer from the server, undefined for an answer to retry at once (login, trust). */
async function detect(dir: string): Promise<{ ws: Workspace | null; failed?: boolean }> {
	let result;
	try {
		result = await p4(["info"], { cwd: dir, timeoutMs: 10_000 });
	} catch {
		return { ws: null, failed: false }; // p4 binary not installed
	}
	const info = result.records[0];
	// No answer. Login and trust errors come back at once and are fixed in a terminal, so ask
	// again next time; a slow or unreachable server is given a pause before the next try.
	if (!info) return { ws: null, failed: isLoginError(result) || isTrustError(result) ? undefined : true };
	if (!info.clientName || info.clientName === "*unknown*" || !info.clientRoot) return { ws: null, failed: false };
	const root = await fs.realpath(info.clientRoot).catch(() => null);
	const realDir = await fs.realpath(dir).catch(() => dir);
	if (!root || !isUnder(realDir, root)) return { ws: null, failed: false };
	const ws = { client: info.clientName, user: info.userName, server: info.serverAddress, root, cwd: realDir };
	knownWorkspaces.push(ws);
	return { ws, failed: false };
}

function fsRealpath(dir: string): string {
	try {
		return fsSync.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

export function isUnder(file: string, root: string): boolean {
	const rel = path.relative(root, file);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface PendingChange {
	change: string;
	/** Full description. */
	desc: string;
}

/** This client's pending changelists, newest first. */
export async function pendingChanges(ws: Workspace): Promise<PendingChange[]> {
	const { records } = await p4Strict(["changes", "-s", "pending", "-c", ws.client, "-l"], { cwd: ws.cwd });
	return records.filter(r => r.change).map(r => ({ change: r.change, desc: (r.desc ?? "").trim() }));
}

/** Whether a p4 error says the changelist is gone or no longer pending (submitted, deleted, someone else's). */
export function isStaleChangeError(err: unknown): boolean {
	const text = err instanceof P4Error ? [...err.result.errors, ...err.result.warnings].join("\n") : String(err);
	return /change \d+ unknown|unknown change|no such changelist|already committed|belongs to (client|user)|is not a pending/i.test(text);
}

/** Create an empty numbered pending changelist and return its number. */
export async function createChange(ws: Workspace, description: string): Promise<string> {
	const body = description
		.trim()
		.split("\n")
		.map(line => `\t${line}`)
		.join("\n");
	const spec = `Change:\tnew\n\nClient:\t${ws.client}\n\nUser:\t${ws.user}\n\nStatus:\tnew\n\nDescription:\n${body}\n`;
	const result = await p4Strict(["change", "-i"], { cwd: ws.cwd, tagged: false, stdin: spec });
	const match = /Change (\d+) created/.exec(result.stdout);
	if (!match) throw new P4Error(`Unexpected 'p4 change -i' output: ${result.stdout.trim()}`, result);
	return match[1];
}

/** Delete a pending changelist; only succeeds when it is empty. */
export async function deleteChange(ws: Workspace, change: string): Promise<void> {
	await p4Strict(["change", "-d", change], { cwd: ws.cwd, tagged: false });
}

/** Files opened in `change`, or in any changelist of this client when `change` is omitted. */
export async function openedFiles(ws: Workspace, change?: string): Promise<OpenedFile[]> {
	const args = ["fstat", "-Ro", ...(change ? ["-e", change] : []), `//${ws.client}/...`];
	const result = await p4(args, { cwd: ws.cwd });
	// "file(s) not opened on this client" is a warning, not an error.
	if (result.errors.length > 0) throw new P4Error(`p4 fstat failed: ${result.errors.join("\n")}`, result);
	return result.records
		.filter(r => r.depotFile && r.action)
		.map(r => ({
			depotFile: r.depotFile,
			localPath: r.clientFile,
			action: r.action,
			change: r.change,
			type: r.type,
			movedFile: r.movedFile,
			unresolved: "unresolved" in r,
		}));
}

/** Which of `files` are open on this client, and in which changelist (one fstat). */
export async function openedState(ws: Workspace, files: string[]): Promise<Map<string, OpenedFile>> {
	const state = new Map<string, OpenedFile>();
	if (files.length === 0) return state;
	const result = await p4(["fstat", ...files], { cwd: ws.cwd });
	for (const r of result.records) {
		if (!r.clientFile || !r.action) continue;
		state.set(r.clientFile, {
			depotFile: r.depotFile,
			localPath: r.clientFile,
			action: r.action,
			change: r.change ?? "default",
			type: r.type,
			movedFile: r.movedFile,
			unresolved: "unresolved" in r,
		});
	}
	return state;
}

/**
 * Open an existing depot file for edit in pending changelist `change` and confirm
 * it became writable. Throws with p4's own message otherwise (exclusive lock held
 * elsewhere, file not in the client view, not on the client, …). Returns the
 * warnings worth telling the agent about: not at head, also opened elsewhere.
 */
export async function openForEdit(ws: Workspace, file: string, change: string): Promise<string[]> {
	const result = await p4Strict(["edit", "-c", change, file], { cwd: ws.cwd });
	const writable = await fs.access(file, fsConstants.W_OK).then(
		() => true,
		() => false,
	);
	if (!writable) {
		const why = [...result.warnings, ...result.errors].join("; ") || "file is still read-only";
		throw new P4Error(`p4 edit did not open ${file} for writing: ${why}`, result);
	}
	return result.warnings.filter(w => /must (sync|resolve)|not.*head|also opened|out of date/i.test(w));
}

/** Open a depot file for delete in `change` (p4 removes the local copy). */
export async function openForDelete(ws: Workspace, file: string, change: string): Promise<void> {
	await p4Strict(["delete", "-c", change, file], { cwd: ws.cwd });
}

export interface ReconcileEntry {
	depotFile: string;
	localPath: string;
	action: string;
}

/**
 * Open adds/edits/deletes the agent made without going through p4 (new files,
 * deletes, moves, bash writes) in `change`. `preview` lists them only.
 */
export async function reconcile(
	ws: Workspace,
	paths: string[],
	options: { preview?: boolean; change?: string; timeoutMs?: number } = {},
): Promise<{ entries: ReconcileEntry[]; warnings: string[] }> {
	if (paths.length === 0) return { entries: [], warnings: [] };
	const target = options.preview ? ["-n"] : options.change ? ["-c", options.change] : [];
	const args = ["reconcile", ...target, ...paths];
	const result = await p4Strict(args, { cwd: ws.cwd, timeoutMs: options.timeoutMs ?? 60_000 });
	// The generated .ignore (see ignore-sync.ts) is local tooling, never depot content.
	const generatedIgnore = path.join(ws.root, ".ignore");
	return {
		entries: result.records
			.filter(r => r.depotFile && r.action && !(r.action === "add" && r.clientFile === generatedIgnore))
			.map(r => ({ depotFile: r.depotFile, localPath: r.clientFile, action: r.action })),
		// "no file(s) to reconcile" and friends are noise.
		warnings: result.warnings.filter(w => !/no file\(s\) to reconcile|file\(s\) up-to-date/i.test(w)),
	};
}

/** Move opened files into another pending changelist. */
export async function reopen(ws: Workspace, change: string, depotFiles: string[]): Promise<void> {
	if (depotFiles.length === 0) return;
	await p4Strict(["reopen", "-c", change, ...depotFiles], { cwd: ws.cwd });
}

// ── Descriptions and review keywords ────────────────────────────────────────

export async function changeDescription(ws: Workspace, change: string): Promise<string> {
	const { records } = await p4Strict(["describe", "-s", change], { cwd: ws.cwd });
	if (!records[0]?.change) throw new Error(`No such changelist ${change}`);
	return (records[0].desc ?? "").trimEnd();
}

export async function setDescription(ws: Workspace, change: string, description: string): Promise<void> {
	const spec = await p4Strict(["change", "-o", change], { cwd: ws.cwd, tagged: false, globals: ["--field", `Description=${description}`] });
	await p4Strict(["change", "-i"], { cwd: ws.cwd, tagged: false, stdin: spec.stdout });
}

const REVIEW_KEYWORD = /#review(?:-\d+)?\b/g;

/**
 * The description with the review keyword P4 Code Review acts on when the
 * change is shelved: `#review` starts a new review, `#review-<id>` adds the
 * change to review <id>. An existing keyword is kept for `true`, replaced for an id.
 */
export function withReviewKeyword(description: string, target: true | number): string {
	const has = description.match(REVIEW_KEYWORD) ?? [];
	if (target === true) return has.length > 0 ? description : `${description.trimEnd()}\n\n#review`;
	const keyword = `#review-${target}`;
	if (has.length === 1 && has[0] === keyword) return description;
	return `${description.replace(REVIEW_KEYWORD, "").trimEnd()}\n\n${keyword}`;
}

/** Make sure pending `change` carries the review keyword; returns the description now set. */
export async function ensureReviewKeyword(ws: Workspace, change: string, target: true | number): Promise<string> {
	const current = await changeDescription(ws, change);
	const wanted = withReviewKeyword(current, target);
	if (wanted !== current) await setDescription(ws, change, wanted);
	return wanted;
}

export function hasReviewKeyword(description: string): boolean {
	return /#review(?:-\d+)?\b/.test(description);
}

// ── Shelves ─────────────────────────────────────────────────────────────────

/** Shelve everything opened in `change`, replacing any previous shelf of it (`-r`). */
export async function shelve(ws: Workspace, change: string): Promise<string[]> {
	const result = await p4Strict(["shelve", "-r", "-c", change], { cwd: ws.cwd, timeoutMs: 120_000 });
	return result.records.filter(r => r.depotFile).map(r => `${r.action ?? "shelved"} ${r.depotFile}`);
}

/**
 * Unshelve `shelf` (yours or someone else's) into pending changelist `change`.
 * Files already open here are scheduled for resolve rather than overwritten.
 */
export async function unshelve(
	ws: Workspace,
	shelf: string,
	change: string,
	files: string[] = [],
): Promise<{ opened: string[]; warnings: string[] }> {
	const result = await p4Strict(["unshelve", "-s", shelf, "-c", change, ...files], { cwd: ws.cwd, timeoutMs: 120_000 });
	return {
		opened: result.records.filter(r => r.depotFile).map(r => `${r.action ?? "unshelved"} ${r.depotFile}`),
		warnings: result.warnings,
	};
}

// ── Resolve ─────────────────────────────────────────────────────────────────

export interface PendingResolve {
	localPath: string;
	fromFile: string;
	revRange: string;
	/** content, filetype, attributes, move, delete, branch, … */
	resolveType: string;
}

/** Files with resolves still scheduled (after sync, unshelve, integrate, merge). */
export async function pendingResolves(ws: Workspace, files: string[] = []): Promise<PendingResolve[]> {
	const result = await p4(["resolve", "-n", ...files], { cwd: ws.cwd });
	if (result.errors.length > 0) throw new P4Error(`p4 resolve -n failed: ${result.errors.join("\n")}`, result);
	return result.records
		.filter(r => r.clientFile)
		.map(r => ({
			localPath: r.clientFile,
			fromFile: r.fromFile ?? "",
			revRange: r.startFromRev && r.endFromRev ? `#${r.startFromRev},#${r.endFromRev}` : r.endFromRev ? `#${r.endFromRev}` : "",
			resolveType: r.resolveType ?? "content",
		}));
}

export type ResolveMode = "auto" | "markers" | "theirs" | "yours";
const RESOLVE_FLAGS: Record<ResolveMode, string> = { auto: "-am", markers: "-af", theirs: "-at", yours: "-ay" };

/**
 * `auto` accepts clean merges only; `markers` accepts the merge with conflict
 * markers in the file for the agent to edit out; `theirs`/`yours` pick a side.
 * `redo` re-resolves files already resolved but not yet submitted (`-f`).
 */
export async function resolve(
	ws: Workspace,
	mode: ResolveMode,
	files: string[] = [],
	redo = false,
): Promise<{ lines: string[]; warnings: string[] }> {
	const args = ["resolve", RESOLVE_FLAGS[mode], ...(redo ? ["-f"] : []), ...files];
	const result = await p4(args, { cwd: ws.cwd, timeoutMs: 120_000 });
	if (result.errors.length > 0 && result.records.length === 0) {
		throw new P4Error(`p4 resolve ${RESOLVE_FLAGS[mode]} failed: ${result.errors.join("\n")}`, result);
	}
	// Each resolved file yields a `how` record ("edit from", "copy from", "ignored", …);
	// the per-file preamble records and "Diff chunks" counts are noise here.
	const lines = result.records.filter(r => r.how && r.toFile).map(r => `${r.toFile}: resolved (${r.how} ${r.fromFile ?? ""})`.trim());
	const warnings = [...result.warnings, ...result.errors].filter(w => !/^Diff chunks:/.test(w));
	return { lines, warnings };
}

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

async function readScannable(file: OpenedFile): Promise<string | undefined> {
	if (file.action.endsWith("delete") || /binary|symlink|apple|resource/.test(file.type)) return undefined;
	const stat = await fs.stat(file.localPath).catch(() => undefined);
	if (!stat?.isFile() || stat.size > MAX_SCAN_BYTES) return undefined;
	return fs.readFile(file.localPath, "utf8").catch(() => undefined);
}

/** Opened text files that still contain conflict markers (Perforce or git style). */
export async function filesWithConflictMarkers(files: OpenedFile[]): Promise<string[]> {
	const hits: string[] = [];
	for (const file of files) {
		const text = await readScannable(file);
		if (text !== undefined && (hasP4Markers(text) || hasGitMarkers(text))) hits.push(file.localPath);
	}
	return hits;
}

/**
 * Rewrite Perforce markers left by `p4 resolve -af` into git diff3 markers so
 * omp's `read` surfaces them as `conflict://<id>` regions. Returns converted paths.
 */
export async function convertMarkersToGit(files: OpenedFile[]): Promise<string[]> {
	const converted: string[] = [];
	for (const file of files) {
		const text = await readScannable(file);
		if (text === undefined || !hasP4Markers(text)) continue;
		const result = p4MarkersToGit(text);
		if (result.converted === 0) continue;
		await Bun.write(file.localPath, result.text);
		converted.push(`${file.localPath} (${result.converted} conflict${result.converted === 1 ? "" : "s"})`);
	}
	return converted;
}

/** Why `files` are not ready to shelve or submit: pending resolves and leftover markers. */
export async function readinessProblems(ws: Workspace, files: OpenedFile[]): Promise<string[]> {
	const problems: string[] = [];
	if (files.length === 0) return problems;
	const pending = await pendingResolves(ws, files.map(f => f.localPath));
	for (const r of pending) problems.push(`needs resolve (${r.resolveType}): ${r.localPath}`);
	for (const p of await filesWithConflictMarkers(files)) problems.push(`conflict markers left in: ${p}`);
	return problems;
}
