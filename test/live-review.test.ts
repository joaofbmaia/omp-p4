/**
 * Live tests for the P4 Code Review (Swarm) client, against a real review server.
 *
 * Opt-in, since it needs a running server:
 *   OMP_P4_REVIEW_WS=<dir with a .p4config for a logged-in user (ticket from `p4 login -a`)>
 *   OMP_P4_REVIEW_URL=<review server base URL, e.g. http://localhost:8080>
 *
 * Each run works under its own depot folder (//depot/omp-p4-test/<run>/) and
 * creates one review with a few comments; nothing else on the server is touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { p4, p4Strict } from "../src/p4";
import {
	findReviewForChange,
	formatComments,
	getComments,
	listMyReviews,
	postComment,
	type Review,
	resolveReview,
	setTaskState,
	waitForReview,
} from "../src/review-server";
import { createChange, ensureReviewKeyword, findWorkspace, openForEdit, reopen, shelve, type Workspace } from "../src/workspace";

const WS_DIR = process.env.OMP_P4_REVIEW_WS;
const ENABLED = Boolean(WS_DIR && process.env.OMP_P4_REVIEW_URL);
const OMP_SRC = process.env.OMP_SRC ?? path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src");
const HAS_OMP = fs.existsSync(path.join(OMP_SRC, "internal-urls/router.ts"));

describe.skipIf(!ENABLED)("live P4 Code Review server", () => {
	const run = `run-${Date.now().toString(36)}`;
	let ws: Workspace;
	let dir: string;
	let depotFile: string;
	let change: string;
	let review: Review;
	let taskId: number;
	const savedConfig = process.env.P4CONFIG;

	afterAll(() => {
		if (savedConfig === undefined) delete process.env.P4CONFIG;
		else process.env.P4CONFIG = savedConfig;
	});

	beforeAll(async () => {
		process.env.P4CONFIG = ".p4config";
		const root = fs.realpathSync(WS_DIR!);
		// Make sure the configured client exists and is rooted at the workspace dir.
		const spec = (await p4(["client", "-o"], { cwd: root, tagged: false })).stdout.replace(/^Root:.*$/m, `Root:\t${root}`);
		await p4Strict(["client", "-i"], { cwd: root, tagged: false, stdin: spec });
		ws = (await findWorkspace(root))!;
		if (!ws) throw new Error(`live review setup: no Perforce client at ${root}`);

		dir = path.join(root, "omp-p4-test", run);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "fifo.sv");
		fs.writeFileSync(file, "module fifo (\n  parameter DEPTH = 8\n);\nendmodule\n");
		await p4Strict(["add", file], { cwd: root });
		await p4Strict(["submit", "-d", `omp-p4 live review test ${run}`], { cwd: root });
		depotFile = `//depot/omp-p4-test/${run}/fifo.sv`;

		await openForEdit(ws, file);
		fs.writeFileSync(file, "module fifo (\n  parameter DEPTH = 16\n);\nendmodule\n");
		change = await createChange(ws, `Deepen FIFO (${run})`);
		await reopen(ws, change, [depotFile]);
	});

	test("#review + shelve starts a review (the team flow); found by change and by id", async () => {
		await ensureReviewKeyword(ws, change, true);
		await shelve(ws, change);
		review = (await waitForReview(ws, Number(change)))!;
		expect(review).toBeDefined();
		expect(review.id).toBeGreaterThan(0);
		expect(review.author).toBe(ws.user);
		expect(review.state).toBe("needsReview");
		expect((await findReviewForChange(ws, Number(change)))?.id).toBe(review.id);
		expect((await resolveReview(ws, Number(change))).id).toBe(review.id);
		expect((await resolveReview(ws, review.id)).id).toBe(review.id);
	});

	test("posts an inline task, a reply and a general comment; reads them back threaded", async () => {
		taskId = await postComment(ws, review.id, "DEPTH should be a power of two, check the pointer width.", {
			file: depotFile,
			line: 2,
			task: true,
		});
		const replyId = await postComment(ws, review.id, "Good catch, will fix.", { parent: taskId });
		const generalId = await postComment(ws, review.id, "Looks good otherwise.");
		const generalReplyId = await postComment(ws, review.id, "Thanks!", { parent: generalId });

		const comments = await getComments(ws, review.id);
		const task = comments.find(c => c.id === taskId)!;
		expect(task).toMatchObject({ taskState: "open", file: depotFile, line: 2, user: ws.user });
		expect(comments.find(c => c.id === replyId)?.parent).toBe(taskId);
		expect(comments.find(c => c.id === generalReplyId)?.parent).toBe(generalId);

		const text = formatComments(review, comments, false);
		expect(text).toContain(`#${taskId} ${ws.user} on ${depotFile}:2 [task: open]`);
		expect(text).toContain(`  ↳ #${replyId} ${ws.user}`);
		expect(text).toContain(`  ↳ #${generalReplyId} ${ws.user}`);
		expect(text.indexOf(`#${taskId}`)).toBeLessThan(text.indexOf("Looks good otherwise."));
		expect(formatComments(review, comments, true)).not.toContain("Looks good otherwise.");
	});

	test("marks a task addressed", async () => {
		await setTaskState(ws, taskId, "addressed");
		const task = (await getComments(ws, review.id)).find(c => c.id === taskId)!;
		expect(task.taskState).toBe("addressed");
	});

	test("#review-<id> + shelve adds another change to the existing review", async () => {
		const file = path.join(dir, "fifo.sv");
		const second = await createChange(ws, `Follow-up (${run})`);
		await reopen(ws, second, [depotFile]);
		fs.writeFileSync(file, "module fifo (\n  parameter DEPTH = 32\n);\nendmodule\n");
		const description = await ensureReviewKeyword(ws, second, review.id);
		expect(description).toEndWith(`#review-${review.id}`);
		await shelve(ws, second);
		let joined: Review | undefined;
		for (let i = 0; i < 30 && !joined?.changes.includes(Number(second)); i++) {
			joined = await waitForReview(ws, Number(second), 2_000);
			if (!joined?.changes.includes(Number(second))) await Bun.sleep(2_000);
		}
		expect(joined?.id).toBe(review.id);
		expect(joined?.changes).toContain(Number(second));
	}, 90_000);

	test("lists the user's open reviews", async () => {
		const mine = await listMyReviews(ws);
		expect(mine.map(r => r.id)).toContain(review.id);
	});

	test.skipIf(!HAS_OMP)("p4://review/<id> and its diff resolve through omp's router", async () => {
		const { InternalUrlRouter } = await import(path.join(OMP_SRC, "internal-urls/router.ts"));
		const { p4Handler } = await import("../src/schemes");
		const router = InternalUrlRouter.instance();
		router.register(p4Handler);
		const ctx = { cwd: ws.cwd };

		const page = await router.resolve(`p4://review/${review.id}`, ctx);
		expect(page.content).toContain(`Review ${review.id} by ${ws.user}`);
		expect(page.content).toContain("Good catch, will fix.");

		// The review server copies the latest shelf (the follow-up change) into the review's own changelist in the background.
		let diff = "";
		for (let i = 0; i < 20 && !diff.includes("+  parameter DEPTH = 32"); i++) {
			diff = (await router.resolve(`p4://review/${review.id}/diff`, ctx)).content;
			if (!diff.includes("+  parameter DEPTH = 32")) await Bun.sleep(1500);
		}
		expect(diff).toContain(`diff --git a/depot/omp-p4-test/${run}/fifo.sv`);
		expect(diff).toContain("+  parameter DEPTH = 32");
	}, 60_000);
});
