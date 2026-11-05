/**
 * Code snapshots for `/branch` rewinds.
 *
 * At the first change of each prompt, the extension records which files are open
 * on the client and in which changelist (one fstat). Then, just before the agent
 * changes a file, its content is copied into memory (edit/write name their files;
 * before bash, the files open in this session's changelists are copied). Rewinding
 * to that prompt therefore puts back contents, adds, deletes and changelist
 * membership, across every changelist, without shelving anything to the server.
 * A file that was not open at the time is, by construction, at its have-revision,
 * so restoring it means `p4 revert`. Files the agent created without opening them
 * are removed again, and unopened files it changed get their old content back.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { p4Strict } from "./p4";
import { createChange, isStaleChangeError, type OpenedFile, openedFiles, openForDelete, reopen, type Workspace } from "./workspace";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

interface OpenedAt {
	action: string;
	change: string;
	depotFile: string;
}

export interface Snapshot {
	takenAt: number;
	/** Files open on the client when the prompt first changed something, by local path. */
	opened: Map<string, OpenedAt>;
	/** Content just before the agent first changed each file; null when the file did not exist. */
	contents: Map<string, Buffer | null>;
	bytes: number;
	/** False once the size or time cap stopped contents being kept; rewind then skips content it lacks. */
	complete: boolean;
	/** Files not copied because of the size cap (not retried every call). */
	skipped: Set<string>;
}

/** Record what is open on the client; contents are captured later, file by file. */
export async function takeSnapshot(ws: Workspace): Promise<Snapshot> {
	const opened = new Map<string, OpenedAt>();
	for (const f of await openedFiles(ws)) opened.set(f.localPath, { action: f.action, change: f.change, depotFile: f.depotFile });
	return { takenAt: Date.now(), opened, contents: new Map(), bytes: 0, complete: true, skipped: new Set() };
}

/**
 * Copy the current content of `files` (first time each is seen this prompt), stopping
 * at `deadline`: a copy taken after the tool started could hold its half-written output.
 */
export async function captureFiles(snapshot: Snapshot, files: string[], deadline = Infinity): Promise<void> {
	for (const file of files) {
		if (snapshot.contents.has(file) || snapshot.skipped.has(file)) continue;
		if (Date.now() > deadline) {
			snapshot.complete = false;
			return;
		}
		const content = await fs.readFile(file).catch(() => null);
		if (content && snapshot.bytes + content.length > MAX_SNAPSHOT_BYTES) {
			snapshot.complete = false;
			snapshot.skipped.add(file);
			continue;
		}
		snapshot.bytes += content?.length ?? 0;
		snapshot.contents.set(file, content);
	}
}

/** Before bash: copy the open files in `changes` (bash may change any of them). */
export async function captureOpened(snapshot: Snapshot, changes?: Set<string>, deadline = Infinity): Promise<void> {
	await captureFiles(
		snapshot,
		[...snapshot.opened].filter(([, f]) => !f.action.endsWith("delete") && (!changes || changes.has(f.change))).map(([p]) => p),
		deadline,
	);
}

export interface RestorePlan {
	/** Opened after the snapshot: back to the have-revision (added files are removed). */
	revert: OpenedFile[];
	/** Same action, different changelist now: move back. */
	move: { file: OpenedFile; to: string }[];
	/** Content, action or open state differs: put back as it was. */
	rewrite: { path: string; was: OpenedAt; content?: Buffer | null; current?: OpenedFile }[];
	/** Never opened: files the agent created are removed, files it changed get their content back. */
	remove: string[];
	unopened: { path: string; content: Buffer }[];
}

/** What restoring `snapshot` would change; empty when the client already matches. */
export async function planRestore(ws: Workspace, snapshot: Snapshot): Promise<RestorePlan> {
	const current = await openedFiles(ws);
	const plan: RestorePlan = { revert: [], move: [], rewrite: [], remove: [], unopened: [] };
	const seen = new Set<string>();
	for (const file of current) {
		seen.add(file.localPath);
		const was = snapshot.opened.get(file.localPath);
		if (!was) {
			plan.revert.push(file);
			continue;
		}
		const content = snapshot.contents.get(file.localPath);
		if (was.action !== file.action) {
			plan.rewrite.push({ path: file.localPath, was, content, current: file });
			continue;
		}
		if (content) {
			const now = await fs.readFile(file.localPath).catch(() => undefined);
			if (!now || !now.equals(content)) {
				plan.rewrite.push({ path: file.localPath, was, content, current: file });
				continue;
			}
		}
		if (was.change !== file.change) plan.move.push({ file, to: was.change });
	}
	for (const [p, was] of snapshot.opened) {
		if (!seen.has(p)) plan.rewrite.push({ path: p, was, content: snapshot.contents.get(p) });
	}
	for (const [p, content] of snapshot.contents) {
		if (seen.has(p) || snapshot.opened.has(p)) continue;
		const now = await fs.readFile(p).catch(() => null);
		if (content === null) {
			if (now !== null) plan.remove.push(p);
		} else if (!now || !now.equals(content)) {
			plan.unopened.push({ path: p, content });
		}
	}
	return plan;
}

export function planIsEmpty(plan: RestorePlan): boolean {
	return plan.revert.length + plan.move.length + plan.rewrite.length + plan.remove.length + plan.unopened.length === 0;
}

export async function applyRestore(ws: Workspace, plan: RestorePlan): Promise<void> {
	// A changelist that was deleted since (it emptied out) gets a stand-in.
	const replaced = new Map<string, string>();
	const into = async <T>(change: string, open: (change: string) => Promise<T>): Promise<T> => {
		const target = replaced.get(change) ?? change;
		try {
			return await open(target);
		} catch (err) {
			if (!isStaleChangeError(err)) throw err;
			const fresh = await createChange(ws, `Restored by rewind (was changelist ${change})`);
			replaced.set(change, fresh);
			return open(fresh);
		}
	};

	// Files opened after the snapshot go back to their have-revision; -w also removes added files.
	if (plan.revert.length > 0) {
		await p4Strict(["revert", "-w", ...plan.revert.map(f => f.localPath)], { cwd: ws.cwd });
	}
	for (const { file, to } of plan.move) await into(to, change => reopen(ws, change, [file.depotFile]));
	for (const item of plan.rewrite) {
		const { was, current } = item;
		if (current && current.action !== was.action) {
			await p4Strict(["revert", "-w", item.path], { cwd: ws.cwd });
		}
		const stillOpen = current && current.action === was.action;
		if (was.action.endsWith("delete")) {
			if (!stillOpen) await into(was.change, change => openForDelete(ws, item.path, change));
			else if (current.change !== was.change) await into(was.change, change => reopen(ws, change, [current.depotFile]));
			continue;
		}
		const isAdd = was.action.endsWith("add") || was.action === "branch";
		if (!isAdd && !stillOpen) await into(was.change, change => p4Strict(["edit", "-c", change, item.path], { cwd: ws.cwd }));
		if (item.content) {
			await fs.mkdir(path.dirname(item.path), { recursive: true });
			await Bun.write(item.path, item.content);
		}
		if (isAdd && !stillOpen) await into(was.change, change => p4Strict(["add", "-c", change, item.path], { cwd: ws.cwd }));
		if (stillOpen && current.change !== was.change) await into(was.change, change => reopen(ws, change, [current.depotFile]));
	}
	for (const p of plan.remove) await fs.rm(p, { force: true });
	for (const { path: p, content } of plan.unopened) {
		await fs.mkdir(path.dirname(p), { recursive: true });
		await Bun.write(p, content);
	}
}

export function describePlan(ws: Workspace, plan: RestorePlan): string {
	const rel = (p: string) => path.relative(ws.cwd, p) || p;
	const cl = (c: string) => (c === "default" ? "the default changelist" : `CL ${c}`);
	return [
		...plan.revert.map(f => `revert   ${rel(f.localPath)} (${f.action})`),
		...plan.move.map(m => `move     ${rel(m.file.localPath)} back to ${cl(m.to)}`),
		...plan.rewrite.map(r => `restore  ${rel(r.path)}${r.was.action !== r.current?.action ? ` (${r.was.action})` : ""}`),
		...plan.remove.map(p => `remove   ${rel(p)} (created since)`),
		...plan.unopened.map(u => `restore  ${rel(u.path)}`),
	].join("\n");
}
