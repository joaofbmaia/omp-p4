/**
 * P4 Code Review (formerly Helix Swarm) REST client.
 *
 * Reads use API v9, which every server since Swarm 2019 offers. Posting splits
 * by what each version can express (checked against P4 Code Review 2026.1):
 * - inline comments go through v9, which fills in the file context itself
 *   (v11 insists the caller sends file type, content and both line numbers);
 * - general comments and replies go through v11 when available, because v9
 *   requires a file on every context and so cannot reply to a general comment.
 *
 * - URL: `OMP_P4_REVIEW_URL`, else the `P4.Swarm.URL` server property that
 *   P4 Code Review registers on install.
 * - Auth: HTTP basic with your p4 user and an existing ticket from `p4 tickets`.
 *   The server validates the ticket against Perforce, so no separate login.
 *   If the review server runs on another host, the ticket must be host-unlocked
 *   (`p4 login -a`).
 */
import { p4 } from "./p4";
import type { Workspace } from "./workspace";

export interface ReviewComment {
	id: number;
	user: string;
	body: string;
	time: number;
	/** comment (plain), open (task), addressed, verified */
	taskState: string;
	file?: string;
	line?: number;
	/** Parent comment id for replies. */
	parent?: number;
	flags: string[];
}

export interface Review {
	id: number;
	author: string;
	state: string;
	description: string;
	changes: number[];
	votes: { user: string; value: number }[];
}

export class ReviewServerError extends Error {
	override name = "ReviewServerError";
}

interface Connection {
	base: string;
	auth: string;
	/** API versions the server reports at /api/version, e.g. [9, 10, 11]. */
	apiVersions: number[];
}

const connections = new Map<string, Promise<Connection>>();

function connect(ws: Workspace): Promise<Connection> {
	let pending = connections.get(ws.client);
	if (!pending) {
		pending = discover(ws);
		connections.set(ws.client, pending);
		pending.catch(() => connections.delete(ws.client));
	}
	return pending;
}

async function discover(ws: Workspace): Promise<Connection> {
	let base = process.env.OMP_P4_REVIEW_URL;
	if (!base) {
		const prop = await p4(["property", "-l", "-n", "P4.Swarm.URL"], { cwd: ws.cwd });
		base = prop.records.find(r => r.value)?.value;
	}
	if (!base) {
		throw new ReviewServerError(
			"No P4 Code Review server found: the P4.Swarm.URL property is not set. Set OMP_P4_REVIEW_URL to its URL.",
		);
	}
	const { stdout } = await p4(["tickets"], { cwd: ws.cwd, tagged: false });
	// Lines look like: `ssl:perforce:1666 (jdoe) 0123456789ABCDEF0123456789ABCDEF`
	const tickets = stdout
		.split("\n")
		.map(line => /^(\S+) \(([^)]+)\) ([0-9A-Fa-f]{32})\s*$/.exec(line.trim()))
		.filter((m): m is RegExpExecArray => m !== null && m[2] === ws.user);
	const serverTail = ws.server.replace(/^ssl:/, "");
	const ticket = (tickets.find(m => m[1].replace(/^ssl:/, "").endsWith(serverTail)) ?? tickets[0])?.[3];
	if (!ticket) throw new ReviewServerError("No p4 ticket found for P4 Code Review: run 'p4 login -a' in a terminal.");
	base = base.replace(/\/+$/, "");
	const version = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(15_000) })
		.then(r => r.json() as Promise<{ apiVersions?: number[] }>)
		.catch(() => ({ apiVersions: [] as number[] }));
	return {
		base,
		auth: `Basic ${Buffer.from(`${ws.user}:${ticket}`).toString("base64")}`,
		apiVersions: version.apiVersions ?? [],
	};
}

/** A form body (v9) or a JSON body (v10+); `version` picks the API. */
async function call<T>(
	ws: Workspace,
	method: string,
	route: string,
	form?: Record<string, string | string[]>,
	options: { version?: number; json?: unknown } = {},
): Promise<T> {
	const { base, auth } = await connect(ws);
	const headers: Record<string, string> = { Authorization: auth, Accept: "application/json" };
	let body: URLSearchParams | string | undefined;
	if (options.json !== undefined) {
		body = JSON.stringify(options.json);
		headers["Content-Type"] = "application/json";
	} else if (form) {
		body = new URLSearchParams();
		for (const [key, value] of Object.entries(form)) {
			for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
		}
	}
	const response = await fetch(`${base}/api/v${options.version ?? 9}/${route}`, {
		method,
		headers,
		body,
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (response.status === 401) {
		connections.delete(ws.client);
		throw new ReviewServerError("P4 Code Review rejected the p4 ticket: run 'p4 login -a' and retry.");
	}
	if (!response.ok) throw new ReviewServerError(`P4 Code Review ${method} ${route}: HTTP ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text) as T;
}

interface RawReview {
	id: number;
	author: string;
	state: string;
	description: string;
	changes?: number[];
	participants?: Record<string, { vote?: { value?: number } | number }>;
	versions?: unknown[];
}

function toReview(raw: RawReview): Review {
	const votes = Object.entries(raw.participants ?? {})
		.map(([user, p]) => ({ user, value: typeof p.vote === "number" ? p.vote : (p.vote?.value ?? 0) }))
		.filter(v => v.value !== 0);
	return {
		id: raw.id,
		author: raw.author,
		state: raw.state,
		description: raw.description,
		changes: raw.changes ?? [],
		votes,
	};
}

export async function getReview(ws: Workspace, id: number): Promise<Review> {
	const { review } = await call<{ review: RawReview }>(ws, "GET", `reviews/${id}`);
	return toReview(review);
}

/** The review a changelist belongs to, if any. */
export async function findReviewForChange(ws: Workspace, change: number): Promise<Review | undefined> {
	const { reviews } = await call<{ reviews: RawReview[] }>(ws, "GET", `reviews?change[]=${change}&max=1`);
	return reviews[0] ? toReview(reviews[0]) : undefined;
}

/** Open reviews you authored or take part in, newest first (for p4:// autocomplete). */
export async function listMyReviews(ws: Workspace, max = 20): Promise<Review[]> {
	const states = ["needsReview", "needsRevision"].map(s => `state[]=${s}`).join("&");
	const [authored, participating] = await Promise.all([
		call<{ reviews: RawReview[] }>(ws, "GET", `reviews?author[]=${encodeURIComponent(ws.user)}&${states}&max=${max}`),
		call<{ reviews: RawReview[] }>(ws, "GET", `reviews?participants[]=${encodeURIComponent(ws.user)}&${states}&max=${max}`),
	]);
	const byId = new Map<number, RawReview>();
	for (const r of [...authored.reviews, ...participating.reviews]) byId.set(r.id, r);
	return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, max).map(toReview);
}

/** Resolve "a review id or a changelist number" the way people refer to reviews. */
export async function resolveReview(ws: Workspace, idOrChange: number): Promise<Review> {
	const byChange = await findReviewForChange(ws, idOrChange).catch(() => undefined);
	if (byChange) return byChange;
	return getReview(ws, idOrChange);
}

interface RawComment {
	id: number;
	user: string;
	body: string;
	time: number;
	taskState?: string;
	flags?: string[];
	context?: { file?: string; rightLine?: number | null; leftLine?: number | null; comment?: number };
}

export async function getComments(ws: Workspace, reviewId: number): Promise<ReviewComment[]> {
	const { comments } = await call<{ comments: RawComment[] }>(ws, "GET", `comments?topic=reviews/${reviewId}&max=1000`);
	return comments.map(c => ({
		id: c.id,
		user: c.user,
		body: c.body,
		time: c.time,
		taskState: c.taskState ?? "comment",
		file: c.context?.file,
		line: c.context?.rightLine ?? c.context?.leftLine ?? undefined,
		parent: c.context?.comment,
		flags: c.flags ?? [],
	}));
}

/** Post a comment, a reply (`parent`) or an inline comment (`file` + `line`); `task` makes it an open task. */
export async function postComment(
	ws: Workspace,
	reviewId: number,
	body: string,
	options: { parent?: number; file?: string; line?: number; task?: boolean } = {},
): Promise<number> {
	const { apiVersions } = await connect(ws);
	if (!options.file && apiVersions.includes(11)) {
		const json = {
			body,
			...(options.task ? { taskState: "open" } : {}),
			...(options.parent !== undefined ? { context: { comment: options.parent } } : {}),
		};
		const result = await call<{ data?: { comments?: RawComment[] } }>(ws, "POST", `comments/reviews/${reviewId}`, undefined, {
			version: 11,
			json,
		});
		const id = result.data?.comments?.[0]?.id;
		if (id === undefined) throw new ReviewServerError("P4 Code Review accepted the comment but returned no id.");
		return id;
	}

	if (options.file) await waitForFirstVersion(ws, reviewId);

	// v9: every context needs a file, so a reply carries its parent's file and line.
	const form: Record<string, string> = { topic: `reviews/${reviewId}`, body };
	if (options.task) form.taskState = "open";
	let file = options.file;
	let line = options.line;
	if (options.parent !== undefined) {
		const parent = (await getComments(ws, reviewId)).find(c => c.id === options.parent);
		if (!parent) throw new ReviewServerError(`Comment #${options.parent} is not on review ${reviewId}.`);
		if (!parent.file) {
			throw new ReviewServerError("This review server (API v9) cannot reply to a general comment; post a new comment instead.");
		}
		form["context[comment]"] = String(options.parent);
		file ??= parent.file;
		line ??= parent.line;
	}
	if (file) form["context[file]"] = file;
	if (line !== undefined) form["context[rightLine]"] = String(line);
	const { comment } = await call<{ comment: RawComment }>(ws, "POST", "comments", form);
	return comment.id;
}

/**
 * Inline comments attach to a review version, which the server's background
 * worker creates shortly after the review. Posting before it exists fails with
 * an HTTP 500 (2026.1), so wait for it.
 */
async function waitForFirstVersion(ws: Workspace, reviewId: number, timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const { review } = await call<{ review: RawReview }>(ws, "GET", `reviews/${reviewId}?fields=id,versions`);
		if ((review.versions ?? []).length > 0) return;
		if (Date.now() > deadline) {
			throw new ReviewServerError(`Review ${reviewId} is still being processed by the review server; try the inline comment again in a minute.`);
		}
		await Bun.sleep(1_000);
	}
}

export async function setTaskState(ws: Workspace, commentId: number, taskState: "open" | "addressed" | "comment"): Promise<void> {
	await call(ws, "PATCH", `comments/${commentId}`, { taskState });
}

/**
 * The review a just-shelved change started or joined via `#review`. The review
 * server handles the shelve in a background worker, so poll for it.
 */
export async function waitForReview(ws: Workspace, change: number, timeoutMs = 60_000): Promise<Review | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const review = await findReviewForChange(ws, change).catch(() => undefined);
		if (review) return review;
		if (Date.now() > deadline) return undefined;
		await Bun.sleep(2_000);
	}
}

/** Model-facing rendering: open tasks first, replies threaded under their parent. */
export function formatComments(review: Review, comments: ReviewComment[], openOnly: boolean): string {
	const live = comments.filter(c => !c.flags.includes("closed"));
	const children = new Map<number, ReviewComment[]>();
	for (const c of live) if (c.parent !== undefined) children.set(c.parent, [...(children.get(c.parent) ?? []), c]);
	const roots = live.filter(c => c.parent === undefined && (!openOnly || c.taskState === "open"));
	const order = (c: ReviewComment) => (c.taskState === "open" ? 0 : c.taskState === "comment" ? 1 : 2);
	roots.sort((a, b) => order(a) - order(b) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));

	const votes = review.votes.map(v => `${v.user} ${v.value > 0 ? "+1" : "-1"}`).join(", ") || "none";
	const lines = [
		`Review ${review.id} by ${review.author} — ${review.state}; changes ${review.changes.join(", ") || "?"}; votes: ${votes}`,
		review.description.trim(),
		"",
	];
	for (const c of roots) {
		const where = c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "(general)";
		const tag = c.taskState === "comment" ? "" : ` [task: ${c.taskState}]`;
		lines.push(`#${c.id} ${c.user} on ${where}${tag}`, indent(c.body));
		for (const reply of children.get(c.id) ?? []) lines.push(`  ↳ #${reply.id} ${reply.user}`, indent(reply.body, 4));
	}
	if (roots.length === 0) lines.push(openOnly ? "(no open tasks)" : "(no comments)");
	return lines.join("\n");
}

function indent(text: string, n = 2): string {
	const pad = " ".repeat(n);
	return text
		.trim()
		.split("\n")
		.map(l => pad + l)
		.join("\n");
}
