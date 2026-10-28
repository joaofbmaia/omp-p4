/**
 * Code snapshots for `/branch` rewinds.
 *
 * Before each prompt, the content of every file open in the work changelist is
 * copied into memory. A file that was not open then is, by construction, still
 * at its have-revision, so restoring it means `p4 revert`. Rewinding to that
 * prompt can therefore put the work changelist back exactly as it was, without
 * shelving anything to the server.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { p4Strict } from "./p4";
import { existingWorkChange, type OpenedFile, openedFiles, openForDelete, type Workspace, workChange } from "./workspace";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

interface SnapshotFile {
	action: string;
	/** Content at snapshot time; undefined for deletes and unreadable or binary files. */
	content?: Buffer;
}

export interface Snapshot {
	takenAt: number;
	files: Map<string, SnapshotFile>;
}

/** Capture the work changelist, or `undefined` when it is too large to hold in memory. */
export async function takeSnapshot(ws: Workspace): Promise<Snapshot | undefined> {
	const files = new Map<string, SnapshotFile>();
	let total = 0;
	const work = await existingWorkChange(ws);
	for (const file of work ? await openedFiles(ws, work) : []) {
		if (file.action.endsWith("delete")) {
			files.set(file.localPath, { action: file.action });
			continue;
		}
		const content = await fs.readFile(file.localPath).catch(() => undefined);
		total += content?.length ?? 0;
		if (total > MAX_SNAPSHOT_BYTES) return undefined;
		files.set(file.localPath, { action: file.action, content });
	}
	return { takenAt: Date.now(), files };
}

export interface RestorePlan {
	revert: OpenedFile[];
	rewrite: { path: string; snapshot: SnapshotFile; current?: OpenedFile }[];
}

/** What restoring `snapshot` would change; empty when the work changelist already matches. */
export async function planRestore(ws: Workspace, snapshot: Snapshot): Promise<RestorePlan> {
	const work = await existingWorkChange(ws);
	const current = work ? await openedFiles(ws, work) : [];
	const plan: RestorePlan = { revert: [], rewrite: [] };
	const seen = new Set<string>();
	for (const file of current) {
		seen.add(file.localPath);
		const snap = snapshot.files.get(file.localPath);
		if (!snap) {
			plan.revert.push(file);
			continue;
		}
		if (snap.action !== file.action) {
			plan.rewrite.push({ path: file.localPath, snapshot: snap, current: file });
			continue;
		}
		if (snap.content) {
			const now = await fs.readFile(file.localPath).catch(() => undefined);
			if (!now || !now.equals(snap.content)) plan.rewrite.push({ path: file.localPath, snapshot: snap, current: file });
		}
	}
	for (const [p, snap] of snapshot.files) if (!seen.has(p)) plan.rewrite.push({ path: p, snapshot: snap });
	return plan;
}

export async function applyRestore(ws: Workspace, plan: RestorePlan): Promise<void> {
	const work = await workChange(ws);
	// Files opened after the snapshot go back to their have-revision; -w also removes added files.
	if (plan.revert.length > 0) {
		await p4Strict(["revert", "-w", ...plan.revert.map(f => f.localPath)], { cwd: ws.cwd });
	}
	for (const item of plan.rewrite) {
		const { snapshot: snap, current } = item;
		if (current && current.action !== snap.action) {
			await p4Strict(["revert", "-w", item.path], { cwd: ws.cwd });
		}
		if (snap.action.endsWith("delete")) {
			if (current?.action !== snap.action) await openForDelete(ws, item.path);
			continue;
		}
		if (snap.content === undefined) continue;
		const isAdd = snap.action.endsWith("add") || snap.action === "branch";
		if (!isAdd && current?.action !== snap.action) {
			await p4Strict(["edit", "-c", work, item.path], { cwd: ws.cwd });
		}
		await fs.mkdir(path.dirname(item.path), { recursive: true });
		await Bun.write(item.path, snap.content);
		if (isAdd && current?.action !== snap.action) {
			await p4Strict(["add", "-c", work, item.path], { cwd: ws.cwd });
		}
	}
}

export function describePlan(ws: Workspace, plan: RestorePlan): string {
	const rel = (p: string) => path.relative(ws.cwd, p) || p;
	return [
		...plan.revert.map(f => `revert   ${rel(f.localPath)} (${f.action})`),
		...plan.rewrite.map(r => `restore  ${rel(r.path)}${r.snapshot.action !== r.current?.action ? ` (${r.snapshot.action})` : ""}`),
	].join("\n");
}
