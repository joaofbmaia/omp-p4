import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePlan } from "../src/change-plan";
import { ChangeRouter, firstLine, provisionalDescription } from "../src/changes";
import type { OpenedFile, Workspace } from "../src/workspace";

const ws: Workspace = { client: "c", user: "u", server: "s", root: "/ws", cwd: "/ws" };

describe("provisional descriptions", () => {
	test("the prompt's first real line, capitalised and capped", () => {
		expect(provisionalDescription("add a testbench for the alu\nwith coverage")).toBe("Add a testbench for the alu");
		expect(provisionalDescription("/p4-change\n\n  fix fifo")).toBe("Fix fifo");
		expect(provisionalDescription("")).toBe("Work in progress (omp)");
		expect(provisionalDescription("x".repeat(100))).toHaveLength(72);
	});

	test("firstLine trims to a width", () => {
		expect(firstLine("Fix FIFO depth\n\nbody", 40)).toBe("Fix FIFO depth");
		expect(firstLine("abcdefghij", 5)).toBe("abcd…");
	});
});

describe("prompt summary", () => {
	test("silent when work only went where it already was", () => {
		const router = new ChangeRouter();
		router.startPrompt("one");
		router.follow(ws, "4711");
		router.noteLanding(ws, "4711", "/ws/a.sv", "edit");
		expect(router.promptSummary()).toContain("CL 4711");
		router.startPrompt("two");
		router.noteLanding(ws, "4711", "/ws/b.sv", "add");
		expect(router.promptSummary()).toBeUndefined();
	});

	test("one line per changelist, files counted once", () => {
		const router = new ChangeRouter();
		router.startPrompt("work");
		router.setDescription("4711", "Fix FIFO depth\n\nlong body");
		router.noteLanding(ws, "4711", "/ws/fifo.sv", "edit");
		router.noteLanding(ws, "4711", "/ws/fifo.sv", "edit");
		router.noteLanding(ws, "4711", "/ws/fifo_pkg.sv", "add");
		router.noteLanding(ws, "4720", "/ws/alu_tb.sv", "add");
		expect(router.promptSummary()).toBe("p4 · CL 4711 Fix FIFO depth: 1 edited, 1 added · CL 4720: 1 added");
	});

	test("a file moved after landing is counted where it ended up", () => {
		const router = new ChangeRouter();
		router.startPrompt("work");
		router.noteLanding(ws, "4730", "/ws/fifo_if.sv", "add");
		router.noteLanding(ws, "4711", "/ws/fifo_if.sv", "add");
		expect(router.promptSummary()).toBe("p4 · CL 4711: 1 added");
	});

	test("the default changelist is never followed", () => {
		const router = new ChangeRouter();
		router.follow(ws, "default");
		expect(router.current(ws)).toBeUndefined();
	});
});

describe("/p4-change plans that join existing changelists", () => {
	const file = (depotFile: string): OpenedFile => ({ depotFile, localPath: depotFile, action: "edit", change: "100", type: "text" });
	const files = [file("//depot/a.sv"), file("//depot/b.sv")];

	test("joins only the user's pending changelists", () => {
		const plan = normalizePlan(
			[
				{ description: "A", files: ["//depot/a.sv"] },
				{ description: "", files: ["//depot/b.sv"], change: "4720" },
			],
			files,
			false,
			new Set(["4720"]),
		);
		expect(plan).toEqual([
			{ description: "A", files: ["//depot/a.sv"] },
			{ description: "Changes made with omp", files: ["//depot/b.sv"], change: "4720" },
		]);
		const unknown = normalizePlan([{ description: "B", files: ["//depot/a.sv", "//depot/b.sv"], change: "9999" }], files, false, new Set(["4720"]));
		expect(unknown[0].change).toBeUndefined();
	});
});

describe("changelists the agent created, across sessions", () => {
	test("remembered in the state file; an edited description becomes the user's", () => {
		const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-p4-state-")), "omp-p4.json");
		fs.writeFileSync(state, JSON.stringify({ declinedIgnore: ["/x"] }));
		const raw = JSON.parse(fs.readFileSync(state, "utf8"));
		raw.createdChanges = { s: { "4730": "Add ALU testbench" } };
		fs.writeFileSync(state, JSON.stringify(raw));

		const next = new ChangeRouter(state);
		expect(next.isCreated(ws, "4730")).toBe(true);
		next.recordDescription(ws, "4730", "ALU: add testbench");
		expect(JSON.parse(fs.readFileSync(state, "utf8"))).toEqual({
			declinedIgnore: ["/x"],
			createdChanges: { s: { "4730": "ALU: add testbench" } },
		});
		// The user rewrote it by hand: no longer the agent's.
		next.setDescription("4730", "ALU testbench, reviewed by Ana");
		expect(next.isCreated(ws, "4730")).toBe(false);
		expect(new ChangeRouter(state).isCreated({ ...ws, server: "other" }, "4730")).toBe(false);
	});
});
