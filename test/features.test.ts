import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GENERATED_HEADER, ignoreState, writeIgnore } from "../src/ignore-sync";
import { fitForReview } from "../src/review";
import { formatComments, type Review, type ReviewComment } from "../src/review-server";
import type { Workspace } from "../src/workspace";

describe("fitForReview", () => {
	test("keeps omp's 20-file / 50k-char review limits, RTL before docs", () => {
		const pieces = [
			{ name: "//depot/README.md", diff: "x".repeat(10_000) },
			...Array.from({ length: 22 }, (_, i) => ({ name: `//depot/rtl/m${i}.sv`, diff: "y".repeat(1_000) })),
		];
		const { kept, dropped } = fitForReview(pieces);
		expect(kept).toHaveLength(20);
		expect(kept.every(p => p.name.endsWith(".sv"))).toBe(true);
		expect(dropped).toContain("//depot/README.md");
		expect(kept.reduce((n, p) => n + p.diff.length + 1, 0)).toBeLessThanOrEqual(50_000);
	});

	test("drops a single oversized file instead of truncating it", () => {
		const { kept, dropped } = fitForReview([
			{ name: "//depot/big.sv", diff: "z".repeat(60_000) },
			{ name: "//depot/small.sv", diff: "z" },
		]);
		expect(kept.map(p => p.name)).toEqual(["//depot/small.sv"]);
		expect(dropped).toEqual(["//depot/big.sv"]);
	});
});

describe("formatComments", () => {
	const review: Review = { id: 42, author: "ana", state: "needsRevision", description: "FIFO depth", changes: [100, 105], votes: [{ user: "rui", value: -1 }] };
	const c = (over: Partial<ReviewComment>): ReviewComment => ({ id: 1, user: "rui", body: "x", time: 0, taskState: "comment", flags: [], ...over });
	const comments = [
		c({ id: 1, body: "Nice", file: "//depot/b.sv", line: 3 }),
		c({ id: 2, body: "Off by one", taskState: "open", file: "//depot/a.sv", line: 10 }),
		c({ id: 3, user: "ana", body: "Fixed?", parent: 2 }),
		c({ id: 4, body: "Old", taskState: "addressed", file: "//depot/a.sv", line: 1 }),
		c({ id: 5, body: "Archived", flags: ["closed"] }),
	];

	test("open tasks first, replies threaded, closed comments hidden", () => {
		const text = formatComments(review, comments, false);
		expect(text).toContain("votes: rui -1");
		expect(text.indexOf("#2 rui on //depot/a.sv:10 [task: open]")).toBeLessThan(text.indexOf("#1 rui on //depot/b.sv:3"));
		expect(text.indexOf("#1 rui")).toBeLessThan(text.indexOf("#4 rui"));
		expect(text).toContain("  ↳ #3 ana");
		expect(text).not.toContain("Archived");
	});

	test("open_only shows just open tasks", () => {
		const text = formatComments(review, comments, true);
		expect(text).toContain("#2 rui");
		expect(text).not.toContain("#1 rui");
		expect(text).not.toContain("#4 rui");
	});
});

describe(".ignore sync", () => {
	const setup = async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-p4-"));
		const ws: Workspace = { client: "c", user: "u", server: "s:1666", root, cwd: root };
		return { root, ws };
	};

	test("missing → written → current → stale after .p4ignore changes", async () => {
		const { root, ws } = await setup();
		expect((await ignoreState(ws)).kind).toBe("none");
		await fs.writeFile(path.join(root, ".p4ignore"), "syn_out/\n");
		const missing = await ignoreState(ws);
		expect(missing.kind).toBe("missing");
		if (missing.kind !== "missing") return;
		await writeIgnore(missing.source, missing.target);
		const written = await fs.readFile(missing.target, "utf8");
		expect(written.startsWith(GENERATED_HEADER)).toBe(true);
		expect(written).toContain("syn_out/");
		expect((await ignoreState(ws)).kind).toBe("current");
		const later = new Date(Date.now() + 5_000);
		await fs.utimes(path.join(root, ".p4ignore"), later, later);
		expect((await ignoreState(ws)).kind).toBe("stale");
	});

	test("never touches a hand-written .ignore", async () => {
		const { root, ws } = await setup();
		await fs.writeFile(path.join(root, ".p4ignore"), "out/\n");
		await fs.writeFile(path.join(root, ".ignore"), "mine/\n");
		expect((await ignoreState(ws)).kind).toBe("foreign");
	});
});
