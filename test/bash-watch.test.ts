import { describe, expect, test } from "bun:test";
import { mayWriteFiles } from "../src/bash-watch";

describe("mayWriteFiles", () => {
	test.each([
		["grep -rn DEPTH rtl/", false],
		["ls -la && cat rtl/fifo.sv", false],
		["p4 opened", false],
		["find . -name '*.sv' | wc -l", false],
		["echo hi > rtl/notes.txt", true],
		["sed -i 's/8/16/' rtl/fifo.sv", true],
		["mv rtl/a.sv rtl/b.sv", true],
		["python3 scripts/gen_regs.py --out rtl/regs.sv", true],
		["./run_lint.sh", true],
		["make -C sim", true],
		["tclsh gen.tcl", true],
	])("%s → %p", (command, expected) => {
		expect(mayWriteFiles(command)).toBe(expected);
	});
});
