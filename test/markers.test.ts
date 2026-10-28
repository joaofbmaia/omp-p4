import { describe, expect, test } from "bun:test";
import { hasGitMarkers, hasP4Markers, p4MarkersToGit } from "../src/markers";

const p4Conflict = [
	"module fifo (",
	">>>> ORIGINAL //depot/rtl/fifo.sv#3",
	"  parameter DEPTH = 8",
	"==== THEIRS //depot/rtl/fifo.sv#4",
	"  parameter DEPTH = 16",
	"==== YOURS //ws/rtl/fifo.sv",
	"  parameter DEPTH = 8, WIDTH = 32",
	"<<<<",
	");",
].join("\n");

describe("p4MarkersToGit", () => {
	test("rewrites a 3-way block into git diff3 markers (ours = YOURS)", () => {
		const { text, converted } = p4MarkersToGit(p4Conflict);
		expect(converted).toBe(1);
		expect(text).toBe(
			[
				"module fifo (",
				"<<<<<<< YOURS //ws/rtl/fifo.sv",
				"  parameter DEPTH = 8, WIDTH = 32",
				"||||||| ORIGINAL //depot/rtl/fifo.sv#3",
				"  parameter DEPTH = 8",
				"=======",
				"  parameter DEPTH = 16",
				">>>>>>> THEIRS //depot/rtl/fifo.sv#4",
				");",
			].join("\n"),
		);
		expect(hasP4Markers(text)).toBe(false);
		expect(hasGitMarkers(text)).toBe(true);
	});

	test("converts several blocks and keeps CRLF", () => {
		const two = `${p4Conflict}\n${p4Conflict}`.replaceAll("\n", "\r\n");
		const { text, converted } = p4MarkersToGit(two);
		expect(converted).toBe(2);
		expect(text.split("\r\n")).toHaveLength(two.split("\r\n").length);
		expect(text.includes("\n") && !/[^\r]\n/.test(text)).toBe(true);
	});

	test("a BOTH-only block collapses to its content", () => {
		const { text } = p4MarkersToGit(["a", ">>>> BOTH //depot/f#2", "same", "<<<<", "b"].join("\n"));
		expect(text).toBe("a\nsame\nb");
	});

	test("leaves unterminated or malformed blocks alone", () => {
		const open = ["x", ">>>> ORIGINAL //depot/f#1", "base", "==== THEIRS //depot/f#2", "t"].join("\n");
		expect(p4MarkersToGit(open)).toEqual({ text: open, converted: 0 });
		const dup = [">>>> ORIGINAL a", "1", "==== ORIGINAL b", "2", "<<<<"].join("\n");
		expect(p4MarkersToGit(dup).converted).toBe(0);
	});

	test("ignores look-alike content", () => {
		const text = ">>>> not a marker\n<<<< also not\n";
		expect(hasP4Markers(text)).toBe(false);
		expect(p4MarkersToGit(text)).toEqual({ text, converted: 0 });
	});
});
