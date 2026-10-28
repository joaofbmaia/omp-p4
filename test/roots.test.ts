import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { canonical, classifyRoot, describeRoots, gitRootOf, groupByWorkspace, p4OwnsPath } from "../src/roots";

// A Perforce client rooted at `client/` (broad, like a client rooted at ~) containing
// a plain depot folder, a nested git checkout and a colocated git+p4 folder; plus a git
// repo outside the client.
let base: string;
const dir = (...p: string[]) => path.join(base, ...p);

const savedPath = process.env.PATH;
afterAll(() => {
	process.env.PATH = savedPath;
	delete process.env.FAKE_P4_ROOT;
});

beforeAll(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-p4-roots-")));
	for (const d of ["client/rtl", "client/tools/gen/.git", "client/tools/gen/src", "outside/.git", "outside/src"]) {
		fs.mkdirSync(dir(d), { recursive: true });
	}
	process.env.FAKE_P4_ROOT = dir("client");
	process.env.PATH = `${path.join(import.meta.dir, "fixtures")}${path.delimiter}${process.env.PATH}`;
});

describe("classifyRoot", () => {
	test("a folder in the client is Perforce", async () => {
		const root = await classifyRoot(dir("client/rtl"));
		expect(root.kind).toBe("p4");
		expect(root.ws?.root).toBe(dir("client"));
	});

	test("a git checkout nested in the client is git, not Perforce", async () => {
		const root = await classifyRoot(dir("client/tools/gen"));
		expect(root.kind).toBe("git");
		expect(root.gitRoot).toBe(dir("client/tools/gen"));
	});

	test("a git repo outside the client is git", async () => {
		expect((await classifyRoot(dir("outside"))).kind).toBe("git");
	});

	test("git sharing the client root (git-p4 style) stays Perforce", async () => {
		fs.mkdirSync(dir("client/.git"), { recursive: true });
		try {
			const root = await classifyRoot(dir("client/rtl"));
			expect(root.kind).toBe("p4");
			expect(root.gitRoot).toBe(dir("client"));
		} finally {
			fs.rmSync(dir("client/.git"), { recursive: true });
		}
	});
});

describe("p4OwnsPath", () => {
	test("depot files yes; files in a nested git checkout or outside the client no", async () => {
		const ws = (await classifyRoot(dir("client/rtl"))).ws!;
		expect(p4OwnsPath(ws, dir("client/rtl/fifo.sv"))).toBe(true);
		expect(p4OwnsPath(ws, dir("client/tools/gen/src/main.py"))).toBe(false);
		expect(p4OwnsPath(ws, dir("client/tools/gen/.git/config"))).toBe(false);
		expect(p4OwnsPath(ws, dir("outside/src/a.ts"))).toBe(false);
	});
});

test("gitRootOf finds the nearest checkout", () => {
	expect(gitRootOf(dir("client/tools/gen/src"))).toBe(dir("client/tools/gen"));
	expect(gitRootOf(dir("outside/src"))).toBe(dir("outside"));
});

test("describeRoots labels each root for the agent", async () => {
	const roots = await Promise.all([classifyRoot(dir("client/rtl")), classifyRoot(dir("outside"))]);
	const text = describeRoots(roots).join("\n");
	expect(text).toContain(`${dir("client/rtl")}: Perforce client "test_ws"`);
	expect(text).toContain(`${dir("outside")}: git repository`);
});

describe("symlinked paths", () => {
	// omp reports cwd as given (/tmp/... on macOS) while p4 reports the real client root
	// (/private/tmp/...). A file reached through a symlink must still count as depot content.
	test("a new file under a symlinked session root is owned by the client", async () => {
		const link = path.join(base, "client-link");
		fs.symlinkSync(dir("client"), link);
		const ctx = { cwd: path.join(link, "rtl"), sessionManager: { getHeader: () => ({}) } } as unknown as ExtensionContext;
		const groups = await groupByWorkspace(ctx, ["new_block.sv", path.join(link, "tools/gen/src/x.py")]);
		expect([...groups.values()].flatMap(g => g.files)).toEqual([dir("client/rtl/new_block.sv")]);
		const ws = (await classifyRoot(dir("client/rtl"))).ws!;
		expect(p4OwnsPath(ws, path.join(link, "rtl/fifo.sv"))).toBe(true);
	});

	test("canonical resolves through the nearest existing ancestor", () => {
		const link = path.join(base, "client-link");
		expect(canonical(path.join(link, "rtl/not/yet/there.sv"))).toBe(dir("client/rtl/not/yet/there.sv"));
	});
});
