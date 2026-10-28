import { describe, expect, test } from "bun:test";
import { normalizePlan, parsePlan } from "../src/change-plan";
import { filePriority } from "../src/diff";
import type { OpenedFile } from "../src/workspace";

const file = (depotFile: string, action = "edit", movedFile?: string): OpenedFile => ({
	depotFile,
	localPath: depotFile.replace("//depot", "/ws"),
	action,
	change: "100",
	type: "text",
	movedFile,
});

describe("parsePlan", () => {
	test("reads JSON wrapped in prose or a code fence", () => {
		const reply = 'Sure:\n```json\n{"changelists":[{"description":"Fix FIFO","files":["//depot/a.sv"]}]}\n```';
		expect(parsePlan(reply)).toEqual([{ description: "Fix FIFO", files: ["//depot/a.sv"] }]);
	});

	test("rejects replies without a plan", () => {
		expect(() => parsePlan("I could not do that")).toThrow();
	});
});

describe("normalizePlan", () => {
	const files = [file("//depot/a.sv"), file("//depot/b.sv"), file("//depot/c.tcl")];

	test("drops unknown and duplicate paths, assigns forgotten files to the first group", () => {
		const plan = normalizePlan(
			[
				{ description: "RTL", files: ["//depot/a.sv", "//depot/nope.sv"] },
				{ description: "Scripts", files: ["//depot/a.sv", "//depot/c.tcl"] },
			],
			files,
			false,
		);
		expect(plan).toEqual([
			{ description: "RTL", files: ["//depot/a.sv", "//depot/b.sv"] },
			{ description: "Scripts", files: ["//depot/c.tcl"] },
		]);
	});

	test("--single merges groups", () => {
		const plan = normalizePlan(
			[
				{ description: "One", files: ["//depot/a.sv"] },
				{ description: "Two", files: ["//depot/b.sv", "//depot/c.tcl"] },
			],
			files,
			true,
		);
		expect(plan).toHaveLength(1);
		expect(plan[0].files.sort()).toEqual(["//depot/a.sv", "//depot/b.sv", "//depot/c.tcl"]);
	});

	test("an empty plan still covers every file", () => {
		const plan = normalizePlan([], files, false);
		expect(plan).toHaveLength(1);
		expect(plan[0].files).toHaveLength(3);
	});

	test("keeps both halves of a move in one changelist", () => {
		const moved = [file("//depot/new.sv", "move/add", "//depot/old.sv"), file("//depot/old.sv", "move/delete", "//depot/new.sv"), file("//depot/x.sv")];
		const plan = normalizePlan(
			[
				{ description: "Rename", files: ["//depot/new.sv"] },
				{ description: "Other", files: ["//depot/old.sv", "//depot/x.sv"] },
			],
			moved,
			false,
		);
		expect(plan).toEqual([
			{ description: "Rename", files: ["//depot/new.sv", "//depot/old.sv"] },
			{ description: "Other", files: ["//depot/x.sv"] },
		]);
	});
});

test("filePriority ranks RTL above docs, tests and binaries", () => {
	expect(filePriority("rtl/fifo.sv")).toBeGreaterThan(filePriority("README.md"));
	expect(filePriority("rtl/fifo.sv")).toBeGreaterThan(filePriority("tb/fifo_tb.sv"));
	expect(filePriority("layout/top.gds")).toBeLessThan(0);
});
