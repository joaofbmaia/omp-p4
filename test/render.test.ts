import { describe, expect, test } from "bun:test";
import { parseDiffs, renderDiffText, renderOpened, renderResolve, renderReview, type ThemeLike } from "../src/render";

// Marks colours as <color:text> so assertions can see what was coloured how.
const theme: ThemeLike = { fg: (c, t) => `<${c}:${t}>`, bold: t => `**${t}**` };

const p4Diff = [
	"=== //depot/rtl/fifo.sv (edit) ===",
	"diff --git a/rtl/fifo.sv b/rtl/fifo.sv",
	"--- a/rtl/fifo.sv",
	"+++ b/rtl/fifo.sv",
	"@@ -1,2 +1,2 @@",
	"-  parameter DEPTH = 8",
	"+  parameter DEPTH = 32",
	"",
	"=== //depot/rtl/notes.md (add) ===",
	"diff --git a/rtl/notes.md b/rtl/notes.md",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/rtl/notes.md",
	"@@ -0,0 +1,1 @@",
	"+FIFO notes",
].join("\n");

const urlDiff = ["diff --git a/depot/rtl/top.sv b/depot/rtl/top.sv", "--- a/depot/rtl/top.sv", "+++ b/depot/rtl/top.sv", "@@ -1 +1,2 @@", " module top;", "+  // v2"].join("\n");

describe("parseDiffs", () => {
	test("p4_diff sections: one file per section, headers dropped, stats counted", () => {
		const files = parseDiffs(p4Diff);
		expect(files.map(f => [f.path, f.action, f.added, f.removed])).toEqual([
			["//depot/rtl/fifo.sv", "edit", 1, 1],
			["//depot/rtl/notes.md", "add", 1, 0],
		]);
		expect(files[0].lines).toEqual(["@@ -1,2 +1,2 @@", "-  parameter DEPTH = 8", "+  parameter DEPTH = 32"]);
	});

	test("p4:// diffs: git headers name the depot file", () => {
		expect(parseDiffs(urlDiff).map(f => [f.path, f.added])).toEqual([["//depot/rtl/top.sv", 1]]);
	});
});

test("collapsed diff is a summary; expanded colours the lines", () => {
	const collapsed = renderDiffText(p4Diff, theme, false);
	expect(collapsed.split("\n")[0]).toBe("2 files <toolDiffAdded:+2> <toolDiffRemoved:-1>");
	expect(collapsed).not.toContain("DEPTH");
	const expanded = renderDiffText(p4Diff, theme, true);
	expect(expanded).toContain("<toolDiffRemoved:-  parameter DEPTH = 8>");
	expect(expanded).toContain("<toolDiffAdded:+  parameter DEPTH = 32>");
	expect(expanded).toContain("<dim:@@ -1,2 +1,2 @@>");
});

test("opened files: counts by action, coloured list when expanded", () => {
	const files = [
		{ action: "edit", depotFile: "//depot/a.sv", change: "4" },
		{ action: "add", depotFile: "//depot/b.sv", change: "4" },
	];
	expect(renderOpened(files, theme, false)).toBe("2 opened · <toolOutput:1 edit>, <toolDiffAdded:1 add>");
	expect(renderOpened(files, theme, true)).toContain("//depot/b.sv <dim:CL 4>");
	expect(renderOpened([], theme, false)).toBe("<dim:no opened files>");
});

test("resolve status and review summaries", () => {
	expect(renderResolve("", { pending: [1, 2], markers: [1] }, theme, false)).toBe("<warning:2 still to resolve · 1 with conflict markers>");
	expect(renderResolve("", { pending: [], markers: [] }, theme, false)).toContain("<success:");
	const review = "Review 9 by ana — needsReview; changes 8; votes: none\nDesc\n\n#1 rui on //depot/a.sv:2 [task: open]\n  Fix\n  ↳ #2 ana\n    Done";
	expect(renderReview(review, theme, false)).toBe("**Review 9 by ana — needsReview** <dim:· 2 comments><warning: · 1 open task>");
});
