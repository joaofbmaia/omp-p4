/**
 * Which pending changelist the agent's work goes into.
 *
 * Perforce is the record: a file that is already open stays in its changelist.
 * Only files that are not open yet need a home, and they follow the work: they
 * go to the changelist of the file the agent last edited. With nothing to follow,
 * a changelist for the task is created on first use, with the prompt as a
 * provisional description for the agent to replace; agent-created changelists
 * that end up empty are deleted. The agent (or you, in words) can point new
 * files elsewhere with p4_change.
 *
 * Changelists the agent created are remembered across sessions in a small state
 * file, with the description it last gave them: while that is unchanged the
 * description is the agent's to rewrite; once you edit it, it is yours.
 */
import * as fs from "node:fs";
import { p4 } from "./p4";
import { createChange, deleteChange, isStaleChangeError, openedFiles, pendingChanges, type Workspace } from "./workspace";

interface StateFile {
	/** Per server: changelists the agent created, with the description it last set. */
	createdChanges?: Record<string, Record<string, string>>;
	[other: string]: unknown;
}

const PROVISIONAL_MAX = 72;

export class ChangeRouter {
	/** Per client: the changelist new files follow. */
	readonly #current = new Map<string, string>();
	/** Per server: changelists the agent created (this or an earlier session) → the description it set. */
	readonly #created: Record<string, Record<string, string>>;
	/** Changelists created in this session, in order (for telling the agent about them). */
	readonly #createdHere: string[] = [];
	/** Per client: changelists the agent worked in this session. */
	readonly #touched = new Map<string, Set<string>>();
	/** Changelists touched before this prompt, to tell what is new. */
	#touchedBefore = new Set<string>();
	/** Where each file this prompt changed ended up, and which changelists the prompt created. */
	#landed = new Map<string, { client: string; change: string; action: string }>();
	#createdThisPrompt = new Set<string>();
	#prompt = "";
	/** Short descriptions for the footer and listings. */
	readonly #descriptions = new Map<string, string>();

	constructor(readonly stateFile?: string) {
		this.#created = this.#readState().createdChanges ?? {};
	}

	startPrompt(prompt: string): void {
		this.#prompt = prompt;
		this.#landed = new Map();
		this.#createdThisPrompt = new Set();
		this.#touchedBefore = new Set([...this.#touched.values()].flatMap(s => [...s]));
	}

	current(ws: Workspace): string | undefined {
		return this.#current.get(ws.client);
	}

	/** The agent created `change` and its description is still the one the agent gave it. */
	isCreated(ws: Workspace, change: string): boolean {
		const set = this.#created[ws.server]?.[change];
		if (set === undefined) return false;
		const now = this.#descriptions.get(change);
		return now === undefined || now.trim() === set.trim();
	}

	touched(ws: Workspace): string[] {
		return [...(this.#touched.get(ws.client) ?? [])];
	}

	description(change: string): string | undefined {
		return this.#descriptions.get(change);
	}

	setDescription(change: string, desc: string): void {
		this.#descriptions.set(change, desc);
	}

	/** The agent (re)described a changelist it created: keep it the agent's. */
	recordDescription(ws: Workspace, change: string, desc: string): void {
		this.#descriptions.set(change, desc);
		if (this.#created[ws.server]?.[change] === undefined) return;
		this.#created[ws.server][change] = desc;
		this.#saveState();
	}

	/** New files follow `change` from now on. */
	follow(ws: Workspace, change: string): void {
		if (change === "default") return; // never route new work into the default changelist
		this.#current.set(ws.client, change);
		this.#touch(ws, change);
	}

	/** Where a file that is not open yet goes: the followed changelist, or a new one for the task. */
	async target(ws: Workspace): Promise<string> {
		return this.current(ws) ?? this.createFor(ws);
	}

	/**
	 * Run `open` against the target changelist; if that changelist was submitted or
	 * deleted behind our back, start a new one and retry once.
	 */
	async withTarget<T>(ws: Workspace, open: (change: string) => Promise<T>): Promise<{ change: string; result: T }> {
		const change = await this.target(ws);
		try {
			return { change, result: await open(change) };
		} catch (err) {
			if (!isStaleChangeError(err)) throw err;
			this.forget(ws, change);
			const fresh = await this.createFor(ws);
			return { change: fresh, result: await open(fresh) };
		}
	}

	/** Create a changelist for the current task and make new files follow it. */
	async createFor(ws: Workspace, description?: string): Promise<string> {
		const desc = description?.trim() || provisionalDescription(this.#prompt);
		const change = await createChange(ws, desc);
		this.#created[ws.server] ??= {};
		this.#created[ws.server][change] = desc;
		this.#saveState();
		this.#createdHere.push(change);
		this.#createdThisPrompt.add(change);
		this.#descriptions.set(change, desc);
		this.follow(ws, change);
		return change;
	}

	/** Changelists this session created, with their descriptions. */
	createdChanges(): [string, string][] {
		return this.#createdHere.map(c => [c, this.#descriptions.get(c) ?? ""]);
	}

	forget(ws: Workspace, change: string): void {
		if (this.#current.get(ws.client) === change) this.#current.delete(ws.client);
		this.#touched.get(ws.client)?.delete(change);
	}

	/** Record that `file` is in `change` with `action`; a later move re-attributes it. */
	noteLanding(ws: Workspace, change: string, file: string, action: string): void {
		this.#touch(ws, change);
		const key = `${ws.client}\0${file}`;
		// Keep the first action seen (an add moved to another changelist is still an add).
		this.#landed.set(key, { client: ws.client, change, action: this.#landed.get(key)?.action ?? action });
	}

	/** One line about this prompt, only when work went somewhere it had not been before. */
	promptSummary(): string | undefined {
		const byChange = new Map<string, { edited: number; added: number; deleted: number }>();
		for (const { change, action } of this.#landed.values()) {
			const counts = byChange.get(change) ?? { edited: 0, added: 0, deleted: 0 };
			if (action.endsWith("add") || action === "branch") counts.added++;
			else if (action.endsWith("delete")) counts.deleted++;
			else counts.edited++;
			byChange.set(change, counts);
		}
		if (![...byChange.keys()].some(c => this.#createdThisPrompt.has(c) || !this.#touchedBefore.has(c))) return undefined;
		const parts = [...byChange].map(([change, l]) => {
			const desc = this.#descriptions.get(change);
			const name = this.#createdThisPrompt.has(change)
				? `new CL ${change}${desc ? ` "${firstLine(desc, 40)}"` : ""}`
				: `CL ${change}${desc ? ` ${firstLine(desc, 30)}` : ""}`;
			const counts = [l.edited && `${l.edited} edited`, l.added && `${l.added} added`, l.deleted && `${l.deleted} deleted`].filter(Boolean).join(", ");
			return `${name}: ${counts}`;
		});
		return `p4 · ${parts.join(" · ")}`;
	}

	/** Delete changelists this session created that ended up empty (and unshelved). */
	async dropEmpty(ws: Workspace, options: { keepCurrent?: boolean } = {}): Promise<string[]> {
		const keep = options.keepCurrent ? this.current(ws) : undefined;
		const mine = this.touched(ws).filter(c => this.#created[ws.server]?.[c] !== undefined && c !== keep);
		if (mine.length === 0) return [];
		const opened = new Set((await openedFiles(ws)).map(f => f.change));
		const dropped: string[] = [];
		for (const change of mine) {
			if (opened.has(change)) continue;
			// p4 refuses to delete a changelist with shelved files; that is what we want.
			const deleted = await deleteChange(ws, change).then(
				() => true,
				() => false,
			);
			if (deleted) {
				this.forget(ws, change);
				delete this.#created[ws.server]?.[change];
				dropped.push(change);
			}
		}
		if (dropped.length) this.#saveState();
		return dropped;
	}

	/**
	 * Refresh the descriptions of this client's pending changelists (one `p4 changes`),
	 * and forget agent-created ones that were submitted or deleted since.
	 */
	async loadDescriptions(ws: Workspace): Promise<void> {
		const pending = await pendingChanges(ws);
		for (const c of pending) this.#descriptions.set(c.change, c.desc);
		const mine = this.#created[ws.server];
		if (!mine) return;
		// Only this client's pending changelists are listed; keep entries that may belong to other clients.
		const gone = Object.keys(mine).filter(c => this.touched(ws).includes(c) && !pending.some(p => p.change === c));
		for (const c of gone) delete mine[c];
		if (gone.length) this.#saveState();
	}

	#readState(): StateFile {
		if (!this.stateFile) return {};
		try {
			return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as StateFile;
		} catch {
			return {};
		}
	}

	#saveState(): void {
		if (!this.stateFile) return;
		try {
			const state = this.#readState();
			state.createdChanges = this.#created;
			fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
		} catch {
			// Losing this only means asking before rewriting a description; never fail the edit.
		}
	}

	#touch(ws: Workspace, change: string): void {
		const set = this.#touched.get(ws.client) ?? new Set<string>();
		set.add(change);
		this.#touched.set(ws.client, set);
	}

}

/** The prompt's first line, as a stand-in description until the agent writes a real one. */
export function provisionalDescription(prompt: string): string {
	const line = prompt
		.split("\n")
		.map(l => l.trim())
		.find(l => l && !l.startsWith("/"));
	if (!line) return "Work in progress (omp)";
	const text = line.length > PROVISIONAL_MAX ? `${line.slice(0, PROVISIONAL_MAX - 1).trimEnd()}…` : line;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function firstLine(desc: string, max: number): string {
	const line = desc.split("\n")[0].trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Find a pending changelist by number or by words from its description ("the alu CL"). */
export async function findChange(ws: Workspace, ref: string): Promise<{ change: string; desc: string } | { candidates: { change: string; desc: string }[] }> {
	const pending = await pendingChanges(ws);
	const number = /^\d+$/.test(ref.trim()) ? ref.trim() : /\b(\d{2,})\b/.exec(ref)?.[1];
	if (number) {
		const hit = pending.find(c => c.change === number);
		if (hit) return hit;
		// Maybe it is someone else's or a different client's: say so rather than guess.
		const other = await p4(["describe", "-s", number], { cwd: ws.cwd });
		const r = other.records[0];
		if (r?.change) throw new Error(`Changelist ${number} is ${r.status === "submitted" ? "already submitted" : `on client ${r.client}, not ${ws.client}`}.`);
		throw new Error(`No changelist ${number}.`);
	}
	const words = ref
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter(w => w.length > 2 && !STOP_WORDS.has(w));
	const scored = pending
		.map(c => ({ c, score: words.filter(w => c.desc.toLowerCase().includes(w)).length }))
		.filter(x => x.score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) return scored[0].c;
	return { candidates: (scored.length ? scored.map(x => x.c) : pending).slice(0, 10) };
}

const STOP_WORDS = new Set(["the", "my", "our", "change", "changelist", "for", "and", "one", "with", "that", "this"]);
