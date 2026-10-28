/**
 * Live tests for real-world Perforce setups beyond the happy path: exclusive
 * locks, streams, Unicode-mode and SSL servers, tickets expiring mid-session
 * and large changelists. Each block starts its own throwaway server (see
 * helpers/server.ts); skipped when p4/p4d are not installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { p4, p4Strict } from "../src/p4";
import { changeDiff } from "../src/review";
import { takeSnapshot } from "../src/snapshots";
import {
	findWorkspace,
	openedFiles,
	openForEdit,
	readinessProblems,
	reconcile,
	shelve,
	unshelve,
	type Workspace,
	workChange,
	createChange,
	reopen,
} from "../src/workspace";
import { isolateP4Env, startServer, type TestServer } from "./helpers/server";

const LIVE = Bun.which("p4") !== null && Bun.which("p4d") !== null;

/** Start a server for one describe block, with the process env sandboxed around it. */
function useServer(options: Parameters<typeof startServer>[0] = {}) {
	const state = { server: undefined as unknown as TestServer, restore: () => {} };
	beforeAll(async () => {
		const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "omp-p4-env-"));
		state.restore = isolateP4Env(fs.realpathSync(sandbox));
		state.server = await startServer(options);
	}, 60_000);
	afterAll(async () => {
		await state.server?.stop();
		state.restore();
	}, 30_000);
	return state;
}

const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

describe.skipIf(!LIVE)("exclusive-lock files (+l)", () => {
	const s = useServer();
	let a: string;
	let b: string;
	let wsA: Workspace;

	beforeAll(async () => {
		const { server } = s;
		a = await server.client("lock_a");
		b = await server.client("lock_b");
		write(path.join(b, "lib/cells.lib"), "library (cells) {}\n");
		await server.run(b, ["add", "-t", "binary+l", "lib/cells.lib"]);
		await server.run(b, ["submit", "-d", "Add locked lib"]);
		await server.run(a, ["sync"]);
		// The colleague (client B) holds the lock.
		await server.run(b, ["edit", "lib/cells.lib"]);
		wsA = (await findWorkspace(a))!;
	});

	test("checking out a file someone else has locked fails with who holds it", async () => {
		const file = path.join(a, "lib/cells.lib");
		let message = "";
		try {
			await openForEdit(wsA, file);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/exclusive/i);
		expect(message).toContain("lock_b");
		expect(fs.statSync(file).mode & 0o200).toBe(0); // still read-only
	});
});

describe.skipIf(!LIVE)("stream depots", () => {
	const s = useServer();
	let dir: string;
	let ws: Workspace;

	beforeAll(async () => {
		const { server } = s;
		const admin = path.join(server.base, "admin");
		await server.run(admin, ["depot", "-i"], "Depot:\tstreams\n\nType:\tstream\n\nStreamDepth:\t//streams/1\n\nMap:\tstreams/...\n");
		await server.run(admin, ["stream", "-i"], await server.run(admin, ["stream", "-o", "-t", "mainline", "//streams/main"]));
		dir = await server.client("stream_ws", { Stream: "//streams/main" });
		write(path.join(dir, "rtl/fifo.sv"), "module fifo;\nendmodule\n");
		await server.run(dir, ["add", "rtl/fifo.sv"]);
		await server.run(dir, ["submit", "-d", "Stream seed"]);
		ws = (await findWorkspace(dir))!;
	});

	test("check-out, reconcile, shelve, unshelve and diffs work in a stream client", async () => {
		expect(ws.client).toBe("stream_ws");
		const file = path.join(dir, "rtl/fifo.sv");
		await openForEdit(ws, file);
		write(file, "module fifo;\n  // edited\nendmodule\n");
		write(path.join(dir, "rtl/new.sv"), "module n;\nendmodule\n");
		const { entries } = await reconcile(ws, [path.join(dir, "rtl/new.sv")]);
		expect(entries.map(e => [e.action, e.depotFile])).toEqual([["add", "//streams/main/rtl/new.sv"]]);
		const change = await createChange(ws, "Stream change");
		await reopen(ws, change, ["//streams/main/rtl/fifo.sv", "//streams/main/rtl/new.sv"]);
		await shelve(ws, change);
		const { pieces } = await changeDiff(ws, change);
		expect(pieces.map(p => p.name).sort()).toEqual(["//streams/main/rtl/fifo.sv", "//streams/main/rtl/new.sv"]);
		await p4Strict(["revert", "-w", "//streams/main/rtl/..."], { cwd: dir });
		const { opened } = await unshelve(ws, change);
		expect(opened.length).toBe(2);
	});
});

describe.skipIf(!LIVE)("Unicode-mode server", () => {
	const s = useServer({ unicode: true });

	test("a workspace without P4CHARSET is still detected and usable", async () => {
		const { server } = s;
		const dir = await server.client("uni_ws");
		write(path.join(dir, "rtl/ünïcode.sv"), "// café\nmodule u;\nendmodule\n");
		await server.run(dir, ["add", "rtl/ünïcode.sv"]);
		await server.run(dir, ["submit", "-d", "Unicode seed"]);
		// Same client, but the user's config does not set P4CHARSET, as is common.
		fs.writeFileSync(path.join(dir, ".p4config"), `P4PORT=${server.port}\nP4USER=${server.user}\nP4CLIENT=uni_ws\n`);
		const ws = await findWorkspace(dir);
		expect(ws?.client).toBe("uni_ws");
		await openForEdit(ws!, path.join(dir, "rtl/ünïcode.sv"));
		expect((await openedFiles(ws!, await workChange(ws!))).map(f => f.depotFile)).toEqual(["//depot/rtl/ünïcode.sv"]);
	});
});

describe.skipIf(!LIVE)("SSL server", () => {
	const s = useServer({ ssl: true });

	test("an untrusted SSL server is reported as such, and works once trusted", async () => {
		const { server } = s;
		const dir = await server.client("ssl_ws");
		// A fresh trust file: the fingerprint is unknown, as on a first connection.
		const trust = path.join(server.base, "trust-fresh");
		const saved = process.env.P4TRUST;
		process.env.P4TRUST = trust;
		try {
			const result = await p4(["info"], { cwd: dir });
			const { isTrustError } = await import("../src/p4");
			expect(isTrustError(result)).toBe(true);
			expect(await findWorkspace(dir)).toBeNull();
			await p4(["trust", "-y"], { cwd: dir, tagged: false });
			expect((await findWorkspace(dir))?.client).toBe("ssl_ws");
		} finally {
			process.env.P4TRUST = saved;
		}
	});
});

describe.skipIf(!LIVE)("ticket expiring mid-session", () => {
	const s = useServer();

	test("an expired ticket produces the 'run p4 login' message", async () => {
		const { server } = s;
		const dir = await server.client("ticket_ws");
		const ws = (await findWorkspace(dir))!;
		await server.run(dir, ["group", "-i"], `Group:\tshort\n\nTimeout:\t1\n\nUsers:\n\t${server.user}\n`);
		await server.run(dir, ["login"], `${server.password}\n`);
		await Bun.sleep(2_500);
		let message = "";
		try {
			await workChange(ws);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/run 'p4 login'/);
		await server.run(dir, ["group", "-d", "short"]).catch(() => {});
	}, 30_000);
});

describe.skipIf(!LIVE)("large changelists", () => {
	const s = useServer();
	const COUNT = 2000;

	test(`${COUNT} files: reconcile, list, readiness check and snapshot stay fast`, async () => {
		const { server } = s;
		const dir = await server.client("big_ws");
		const ws = (await findWorkspace(dir))!;
		const files = Array.from({ length: COUNT }, (_, i) => path.join(dir, `gen/blk${Math.floor(i / 100)}/cell_${i}.sv`));
		for (const [i, f] of files.entries()) write(f, `module cell_${i};\nendmodule\n`);

		const timings: Record<string, number> = {};
		const time = async <T>(label: string, fn: () => Promise<T>) => {
			const t = performance.now();
			const out = await fn();
			timings[label] = Math.round(performance.now() - t);
			return out;
		};
		const { entries } = await time("reconcile (explicit paths)", () => reconcile(ws, files));
		expect(entries.length).toBe(COUNT);
		const opened = await time("opened files", async () => openedFiles(ws, await workChange(ws)));
		expect(opened.length).toBe(COUNT);
		expect(await time("readiness check", () => readinessProblems(ws, opened))).toEqual([]);
		const snapshot = await time("snapshot", () => takeSnapshot(ws));
		expect(snapshot?.files.size).toBe(COUNT);
		console.log("large changelist timings (ms):", timings);
		for (const ms of Object.values(timings)) expect(ms).toBeLessThan(30_000);
	}, 180_000);
});

describe.skipIf(!LIVE)("files changed by bash", () => {
	const s = useServer();

	test("finds what a command changed in its folder and the paths it names, not elsewhere", async () => {
		const { server } = s;
		const dir = await server.client("bash_ws");
		write(path.join(dir, "rtl/fifo.sv"), "module fifo;\nendmodule\n");
		await server.run(dir, ["add", "rtl/fifo.sv"]);
		await server.run(dir, ["submit", "-d", "seed"]);
		const ws = (await findWorkspace(dir))!;
		const { scanTargets, unopenedChanges } = await import("../src/bash-watch");

		// What `sed -i … rtl/fifo.sv && python gen.py --out gen/regs.sv && touch rtl/new.sv` would leave behind.
		const fifo = path.join(dir, "rtl/fifo.sv");
		fs.chmodSync(fifo, 0o644);
		write(fifo, "module fifo;\n  // sed\nendmodule\n");
		write(path.join(dir, "gen/regs.sv"), "// generated\n");
		write(path.join(dir, "rtl/new.sv"), "module n;\nendmodule\n");
		write(path.join(dir, "elsewhere/deep/untouched.sv"), "// not named by the command\n");

		const command = "sed -i s/x/y/ fifo.sv && python ../gen.py --out ../gen/regs.sv && touch new.sv";
		const targets = scanTargets(ws, command, path.join(dir, "rtl"));
		const found = (await unopenedChanges(ws, targets)).map(c => `${c.action} ${c.depotFile}`).sort();
		expect(found).toEqual(["add //depot/gen/regs.sv", "add //depot/rtl/new.sv", "edit //depot/rtl/fifo.sv"]);
	});
});
