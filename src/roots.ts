/**
 * Multi-root sessions (omp's `/add-dir`) mixing Perforce and git.
 *
 * Each session root is classified by the *nearest* version control: a git
 * checkout inside a Perforce client belongs to git. That matters because p4
 * client roots are often broad (`~`, `/`), and would otherwise claim every git
 * repo below them. When git and p4 share the same root (git-p4, or a local git
 * kept on top of a p4 workspace), Perforce owns it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { p4 } from "./p4";
import { findWorkspace, isUnder, type Workspace } from "./workspace";

export interface RootInfo {
	dir: string;
	kind: "p4" | "git" | "none";
	ws?: Workspace;
	gitRoot?: string;
}

/**
 * The nearest directory at or above `dir` containing `.git`, if any. Not cached:
 * a repo cloned or initialised mid-session must be seen at once, or its files
 * would be opened in Perforce. It is a handful of stat calls.
 */
export function gitRootOf(dir: string): string | undefined {
	let current = path.resolve(dir);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * `file` with symlinks resolved, so it compares against p4's realpath'd client
 * root (`/tmp` → `/private/tmp` on macOS; symlinked or automounted project dirs
 * on Linux). A path that does not exist yet (or any more) resolves through its
 * nearest existing ancestor.
 */
export function canonical(file: string): string {
	const abs = path.resolve(file);
	const missing: string[] = [];
	let current = abs;
	while (true) {
		try {
			return path.join(fs.realpathSync(current), ...missing.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return abs;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

/** True when `inner` is strictly below `outer`. */
function deeper(inner: string, outer: string): boolean {
	return inner !== outer && isUnder(inner, outer);
}

/** p4 owns `file` unless a git checkout strictly inside the client root is nearer. */
export function p4OwnsPath(ws: Workspace, file: string): boolean {
	file = canonical(file);
	if (!isUnder(file, ws.root)) return false;
	const git = gitRootOf(path.dirname(file));
	return !git || !deeper(git, ws.root);
}

/** Session roots: the working directory plus `/add-dir` directories. */
export function sessionDirs(ctx: ExtensionContext): string[] {
	const extra = ctx.sessionManager.getHeader()?.additionalDirectories ?? [];
	return [...new Set([ctx.cwd, ...extra].map(d => canonical(d)))];
}

export async function classifyRoot(dir: string): Promise<RootInfo> {
	const ws = await findWorkspace(dir);
	const gitRoot = gitRootOf(dir);
	if (ws && (!gitRoot || !deeper(gitRoot, ws.root))) return { dir, kind: "p4", ws, gitRoot };
	if (gitRoot) return { dir, kind: "git", gitRoot };
	return { dir, kind: "none" };
}

export async function sessionRoots(ctx: ExtensionContext): Promise<RootInfo[]> {
	return Promise.all(sessionDirs(ctx).map(classifyRoot));
}

/** One workspace per Perforce client across the session roots (two roots in one client share it). */
export async function p4Workspaces(ctx: ExtensionContext): Promise<Workspace[]> {
	const byClient = new Map<string, Workspace>();
	for (const root of await sessionRoots(ctx)) {
		if (root.ws && root.kind === "p4" && !byClient.has(root.ws.client)) byClient.set(root.ws.client, root.ws);
	}
	return [...byClient.values()];
}

/** The Perforce workspace owning `file`, or null for git-owned or untracked paths. */
export async function workspaceForPath(ctx: ExtensionContext | undefined, file: string): Promise<Workspace | null> {
	const abs = canonical(path.resolve(ctx?.cwd ?? process.cwd(), file));
	// Prefer the session root containing the file: one `p4 info` per root, not per directory.
	const roots = ctx ? await sessionRoots(ctx) : [];
	const root = roots
		.filter(r => r.kind === "p4" && r.ws && isUnder(abs, r.dir))
		.sort((a, b) => b.dir.length - a.dir.length)[0];
	const ws = root?.ws ?? (await findWorkspace(fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)));
	return ws && p4OwnsPath(ws, abs) ? ws : null;
}

/** The workspace commands use when nothing more specific is known: the cwd's, else the first Perforce root. */
export async function defaultWorkspace(ctx: ExtensionContext): Promise<Workspace | null> {
	const roots = await sessionRoots(ctx);
	return roots.find(r => r.dir === path.resolve(ctx.cwd) && r.kind === "p4")?.ws ?? roots.find(r => r.kind === "p4")?.ws ?? null;
}

/** The session workspace whose client owns pending `change`, else the default one. */
export async function workspaceForChange(ctx: ExtensionContext, change: string): Promise<Workspace | null> {
	const all = await p4Workspaces(ctx);
	if (all.length <= 1) return all[0] ?? null;
	const { records } = await p4(["describe", "-s", change], { cwd: all[0].cwd });
	const client = records[0]?.client;
	return all.find(ws => ws.client === client) ?? (await defaultWorkspace(ctx));
}

/** Group paths by owning Perforce workspace; git-owned and untracked paths are dropped. */
export async function groupByWorkspace(
	ctx: ExtensionContext,
	files: string[],
): Promise<Map<string, { ws: Workspace; files: string[] }>> {
	const groups = new Map<string, { ws: Workspace; files: string[] }>();
	for (const file of files) {
		const ws = await workspaceForPath(ctx, file);
		if (!ws) continue;
		const group = groups.get(ws.client) ?? { ws, files: [] };
		group.files.push(canonical(path.resolve(ctx.cwd, file)));
		groups.set(ws.client, group);
	}
	return groups;
}

/** System-prompt lines describing which root uses which VCS. */
export function describeRoots(roots: RootInfo[]): string[] {
	if (roots.length <= 1) return [];
	return [
		"This session has several workspace roots:",
		...roots.map(r =>
			r.kind === "p4"
				? `- ${r.dir}: Perforce client "${r.ws!.client}"${r.gitRoot === r.ws!.root ? " (a git checkout shares this root; use p4 for depot files)" : ""}`
				: r.kind === "git"
					? `- ${r.dir}: git repository (${r.gitRoot}); use git here, not p4`
					: `- ${r.dir}: not under version control`,
		),
	];
}
