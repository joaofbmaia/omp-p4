/**
 * Live tests against a real, throwaway Perforce server.
 *
 * Runs when `p4` and `p4d` are on PATH (skipped otherwise). The server uses an
 * `rsh:` port, so p4d starts on demand per command: no daemon, no open port.
 * Everything lives in a temp dir; P4CONFIG/P4TICKETS/P4ENVIRO point there so a
 * real Perforce setup in your environment is never touched.
 *
 * Parts that exercise omp itself (the p4:// router, the conflict scanner) load
 * omp from OMP_SRC (default: the global bun install) and skip if it is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { diffOpenedFile } from "../src/diff";
import { ignoreState } from "../src/ignore-sync";
import { p4 } from "../src/p4";
import { changeDiff } from "../src/review";
import { classifyRoot, groupByWorkspace, p4OwnsPath } from "../src/roots";
import { applyRestore, planRestore, takeSnapshot } from "../src/snapshots";
import {
	convertMarkersToGit,
	createChange,
	existingWorkChange,
	findWorkspace,
	openedFiles,
	openForEdit,
	pendingResolves,
	readinessProblems,
	reconcile,
	reopen,
	resolve,
	shelve,
	unshelve,
	type Workspace,
	workChange,
} from "../src/workspace";

const has = (bin: string) => Bun.which(bin) !== null;
const LIVE = has("p4") && has("p4d");
const OMP_SRC = process.env.OMP_SRC ?? path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src");
const HAS_OMP = fs.existsSync(path.join(OMP_SRC, "internal-urls/router.ts"));

let base = "";
let wsA: Workspace;
/** Number of the "top v2" change B submits. */
let topV2 = "";
const a = (...p: string[]) => path.join(base, "a", ...p);
const b = (...p: string[]) => path.join(base, "b", ...p);
const read = (p: string) => fs.readFileSync(p, "utf8");
const writable = (p: string) => {
	try {
		fs.accessSync(p, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/** Run p4 as client B (the "colleague"); throws on failure. */
async function asB(args: string[], stdin?: string): Promise<string> {
	const r = await p4(args, { cwd: b(), tagged: false, stdin });
	if (r.exitCode !== 0) throw new Error(`p4 ${args.join(" ")}: ${r.stdout}${r.errors.join("\n")}`);
	return r.stdout;
}

function fakeCtx(cwd: string, extra: string[] = []): ExtensionContext {
	return { cwd, sessionManager: { getHeader: () => ({ additionalDirectories: extra }) } } as unknown as ExtensionContext;
}

describe.skipIf(!LIVE)("live Perforce server", () => {
	const P4_ENV = ["P4PORT", "P4USER", "P4CLIENT", "P4PASSWD", "P4CONFIG", "P4TICKETS", "P4ENVIRO"];
	const savedEnv = Object.fromEntries(P4_ENV.map(k => [k, process.env[k]]));
	afterAll(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	beforeAll(async () => {
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-p4-live-")));
		fs.mkdirSync(path.join(base, "srv"));
		for (const [dir, client] of [
			[a(), "client_a"],
			[b(), "client_b"],
		]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, ".p4config"),
				`P4PORT=rsh:p4d -r ${base}/srv -L ${base}/srv/log -i\nP4USER=tester\nP4CLIENT=${client}\n`,
			);
		}
		for (const key of ["P4PORT", "P4USER", "P4CLIENT", "P4PASSWD"]) delete process.env[key];
		Object.assign(process.env, { P4CONFIG: ".p4config", P4TICKETS: `${base}/tickets`, P4ENVIRO: `${base}/enviro` });

		// Brand-new 2025+ servers refuse access until the first user has a password. Give the
		// throwaway user a random one (via passwd's prompts) and log in; the ticket lands in
		// the temp P4TICKETS. The password is never printed or written anywhere.
		Bun.spawnSync(["p4d", "-r", `${base}/srv`, "-cset security=0"]);
		const password = `Tt-${crypto.randomUUID()}-9`;
		await p4(["passwd"], { cwd: a(), tagged: false, stdin: `${password}\n${password}\n` });
		const login = await p4(["login"], { cwd: a(), tagged: false, stdin: `${password}\n` });
		if (login.exitCode !== 0) throw new Error(`live setup: p4 login failed: ${login.errors.join("; ")}`);

		for (const [dir, client] of [
			[a(), "client_a"],
			[b(), "client_b"],
		]) {
			const spec = (await p4(["client", "-o", client], { cwd: dir, tagged: false })).stdout.replace(/^Root:.*$/m, `Root:\t${dir}`);
			await p4(["client", "-i"], { cwd: dir, tagged: false, stdin: spec });
		}
		fs.mkdirSync(b("rtl"), { recursive: true });
		fs.writeFileSync(b("rtl/fifo.sv"), "module fifo (\n  parameter DEPTH = 8\n);\nendmodule\n");
		fs.writeFileSync(b("rtl/top.sv"), "module top;\nendmodule\n");
		await asB(["add", "rtl/..."]);
		await asB(["submit", "-d", "Initial RTL"]);
		await p4(["sync"], { cwd: a(), tagged: false });
		// A git checkout nested inside client A's root.
		fs.mkdirSync(a("tools/gen/.git"), { recursive: true });

		const ws = await findWorkspace(a());
		if (!ws) throw new Error("live setup failed: client_a not detected (did p4d's first-user behaviour change?)");
		wsA = ws;
	});

	test("detects the client; the work changelist is only created when needed", async () => {
		expect(wsA.client).toBe("client_a");
		expect(wsA.root).toBe(a());
		expect(await existingWorkChange(wsA)).toBeUndefined();
		const work = await workChange(wsA);
		expect(work).toMatch(/^\d+$/);
		expect(await existingWorkChange(wsA)).toBe(work);
	});

	test("synced files are read-only; openForEdit checks out into the work changelist", async () => {
		expect(writable(a("rtl/fifo.sv"))).toBe(false);
		expect(await openForEdit(wsA, a("rtl/fifo.sv"))).toEqual([]);
		expect(writable(a("rtl/fifo.sv"))).toBe(true);
		const opened = await openedFiles(wsA, await workChange(wsA));
		expect(opened.map(f => [f.action, f.depotFile])).toEqual([["edit", "//depot/rtl/fifo.sv"]]);
	});

	test("editing a file that is not at head reports it", async () => {
		await asB(["edit", "rtl/top.sv"]);
		fs.writeFileSync(b("rtl/top.sv"), "module top;\n  // v2\nendmodule\n");
		topV2 = /Change (\d+) submitted/.exec(await asB(["submit", "-d", "top v2"]))![1];
		const warnings = await openForEdit(wsA, a("rtl/top.sv"));
		expect(warnings.join("\n")).toMatch(/must sync\/resolve/);
		await p4(["revert", a("rtl/top.sv")], { cwd: a(), tagged: false });
		await p4(["sync"], { cwd: a(), tagged: false });
	});

	test("new files are opened for add; files in a nested git checkout are left alone", async () => {
		fs.writeFileSync(a("rtl/new.sv"), "module new_block;\nendmodule\n");
		fs.mkdirSync(a("tools/gen/src"), { recursive: true });
		fs.writeFileSync(a("tools/gen/src/gen.py"), "print('hi')\n");
		const groups = await groupByWorkspace(fakeCtx(a()), [a("rtl/new.sv"), a("tools/gen/src/gen.py")]);
		expect([...groups.values()].flatMap(g => g.files)).toEqual([a("rtl/new.sv")]);
		const { entries } = await reconcile(wsA, [a("rtl/new.sv")]);
		expect(entries.map(e => e.action)).toEqual(["add"]);
		expect(p4OwnsPath(wsA, a("tools/gen/.git/config"))).toBe(false);
		expect((await classifyRoot(a("tools/gen"))).kind).toBe("git");
	});

	test("diffs use git-style headers for edits and adds", async () => {
		fs.writeFileSync(a("rtl/fifo.sv"), "module fifo (\n  parameter DEPTH = 16\n);\nendmodule\n");
		const opened = await openedFiles(wsA, await workChange(wsA));
		const edit = await diffOpenedFile(wsA, opened.find(f => f.action === "edit")!);
		expect(edit).toStartWith("diff --git a/rtl/fifo.sv b/rtl/fifo.sv\n--- a/rtl/fifo.sv\n+++ b/rtl/fifo.sv\n@@");
		expect(edit).toContain("-  parameter DEPTH = 8\n+  parameter DEPTH = 16");
		const add = await diffOpenedFile(wsA, opened.find(f => f.action === "add")!);
		expect(add).toContain("--- /dev/null\n+++ b/rtl/new.sv\n@@ -0,0 +1,2 @@\n+module new_block;");
	});

	test("rewind snapshots restore content and revert files opened later", async () => {
		const snapshot = (await takeSnapshot(wsA))!;
		fs.writeFileSync(a("rtl/fifo.sv"), "module fifo (\n  parameter DEPTH = 99\n);\nendmodule\n");
		fs.writeFileSync(a("rtl/later.sv"), "module later;\nendmodule\n");
		await reconcile(wsA, [a("rtl/later.sv")]);
		const plan = await planRestore(wsA, snapshot);
		expect(plan.revert.map(f => f.depotFile)).toEqual(["//depot/rtl/later.sv"]);
		expect(plan.rewrite.map(r => r.path)).toEqual([a("rtl/fifo.sv")]);
		await applyRestore(wsA, plan);
		expect(read(a("rtl/fifo.sv"))).toContain("DEPTH = 16");
		expect(fs.existsSync(a("rtl/later.sv"))).toBe(false);
		const again = await planRestore(wsA, snapshot);
		expect(again.revert.length + again.rewrite.length).toBe(0);
	});

	test("new changelists, shelving (first time with -r) and shelf diffs", async () => {
		const change = await createChange(wsA, "Deepen FIFO\n\nDEPTH 8 -> 16.");
		await reopen(wsA, change, ["//depot/rtl/fifo.sv"]);
		expect(await shelve(wsA, change)).toHaveLength(1);
		const { pieces, label } = await changeDiff(wsA, change);
		expect(label).toStartWith(`Shelf ${change} by tester: Deepen FIFO`);
		expect(pieces[0].diff).toContain("diff --git a/depot/rtl/fifo.sv b/depot/rtl/fifo.sv");
		expect(pieces[0].diff).toContain("+  parameter DEPTH = 16");
		await expect(changeDiff(wsA, "99999")).rejects.toThrow(/no such changelist/);
	});

	test("unshelving onto an open file schedules a resolve; markers convert to omp's format", async () => {
		// Colleague B shelves a conflicting change to the same line.
		await asB(["edit", "rtl/fifo.sv"]);
		fs.writeFileSync(b("rtl/fifo.sv"), "module fifo (\n  parameter DEPTH = 64\n);\nendmodule\n");
		const created = await asB(["change", "-i"], "Change:\tnew\n\nClient:\tclient_b\n\nUser:\ttester\n\nStatus:\tnew\n\nDescription:\n\tDEPTH 64\n");
		const shelf = /Change (\d+) created/.exec(created)![1];
		await asB(["reopen", "-c", shelf, "rtl/fifo.sv"]);
		await asB(["shelve", "-c", shelf]);

		const { warnings } = await unshelve(wsA, shelf, ["//depot/rtl/fifo.sv"]);
		expect(warnings.join("\n")).toMatch(/must resolve/);
		const pending = await pendingResolves(wsA);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ localPath: a("rtl/fifo.sv"), fromFile: "//depot/rtl/fifo.sv", resolveType: "content" });

		const auto = await resolve(wsA, "auto");
		expect(auto.lines).toEqual([]);
		expect(auto.warnings.join("\n")).toMatch(/resolve skipped/);
		expect(await pendingResolves(wsA)).toHaveLength(1);

		const markers = await resolve(wsA, "markers");
		expect(markers.lines.join("\n")).toMatch(/resolved/);
		expect(read(a("rtl/fifo.sv"))).toContain("==== THEIRS ");
		const converted = await convertMarkersToGit(await openedFiles(wsA));
		expect(converted).toHaveLength(1);
		const text = read(a("rtl/fifo.sv"));
		expect(text).toContain("<<<<<<< YOURS");
		expect(text).toContain("||||||| ORIGINAL //depot/rtl/fifo.sv#1");

		const problems = await readinessProblems(wsA, await openedFiles(wsA));
		expect(problems.join("\n")).toMatch(/conflict markers left in/);

		if (HAS_OMP) {
			const { scanConflictLines } = await import(path.join(OMP_SRC, "tools/conflict-detect.ts"));
			const [block] = scanConflictLines(text.split("\n"), 1);
			expect(block.oursLines).toEqual(["  parameter DEPTH = 16"]);
			expect(block.theirsLines).toEqual(["  parameter DEPTH = 64"]);
			expect(block.baseLines).toEqual(["  parameter DEPTH = 8"]);
		}

		fs.writeFileSync(a("rtl/fifo.sv"), "module fifo (\n  parameter DEPTH = 64\n);\nendmodule\n");
		expect(await readinessProblems(wsA, await openedFiles(wsA))).toEqual([]);
	});

	test.skipIf(!HAS_OMP)("p4:// resolves through omp's own URL router", async () => {
		const { InternalUrlRouter } = await import(path.join(OMP_SRC, "internal-urls/router.ts"));
		const { p4Handler } = await import("../src/schemes");
		const router = InternalUrlRouter.instance();
		router.register(p4Handler);
		const ctx = { cwd: a() };

		const file = await router.resolve("p4://depot/rtl/top.sv#1", ctx);
		expect(file.content).toBe("module top;\nendmodule\n");
		expect(file.notes).toEqual(["//depot/rtl/top.sv#1 - add change 1 (text)"]);
		expect(file.immutable).toBe(true);

		const folder = await router.resolve("p4://depot/rtl/", ctx);
		expect(folder.content).toContain("- p4://depot/rtl/fifo.sv  #1 text, change 1");

		const change = await router.resolve("p4://1", ctx);
		expect(change.content).toContain("# Change 1 — submitted");
		expect(change.content).toContain("- add //depot/rtl/fifo.sv#1");

		const diff = await router.resolve(`p4://${topV2}/diff`, ctx);
		expect(diff.content).toContain("diff --git a/depot/rtl/top.sv b/depot/rtl/top.sv");
		expect(diff.content).toContain("+  // v2");

		await expect(router.resolve("p4://99999", ctx)).rejects.toThrow(/no such changelist/);
	});

	test("P4IGNORE lookup finds the client-root .p4ignore", async () => {
		fs.writeFileSync(a(".p4ignore"), "syn_out/\n");
		expect((await ignoreState(wsA)).kind).toBe("missing");
	});
});
