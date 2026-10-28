import { describe, expect, test } from "bun:test";
import { classify, parseDepotRef } from "../src/schemes";

describe("p4:// classify", () => {
	test.each([
		["12345", { kind: "change", change: "12345", sub: undefined }],
		["12345/diff", { kind: "change", change: "12345", sub: "diff" }],
		["review/4521", { kind: "review", id: "4521", sub: undefined }],
		["review/4521/diff/", { kind: "review", id: "4521", sub: "diff" }],
		["depot/main/rtl/fifo.sv#5", { kind: "depot", path: "depot/main/rtl/fifo.sv#5" }],
		["//depot/main/rtl/", { kind: "depot", path: "depot/main/rtl/" }],
		["review/docs/readme.md", { kind: "depot", path: "review/docs/readme.md" }],
	])("%s", (input, expected) => {
		expect(classify(input)).toEqual(expected as ReturnType<typeof classify>);
	});
});

describe("parseDepotRef", () => {
	test("splits revision specifiers", () => {
		expect(parseDepotRef("depot/main/rtl/fifo.sv#5")).toEqual({ path: "//depot/main/rtl/fifo.sv", rev: "#5", folder: false });
		expect(parseDepotRef("depot/main/rtl/fifo.sv@=12345")).toEqual({ path: "//depot/main/rtl/fifo.sv", rev: "@=12345", folder: false });
		expect(parseDepotRef("depot/main/rtl/fifo.sv")).toEqual({ path: "//depot/main/rtl/fifo.sv", rev: "", folder: false });
	});

	test("trailing slash or bare depot name is a folder", () => {
		expect(parseDepotRef("depot/main/rtl/")).toEqual({ path: "//depot/main/rtl", rev: "", folder: true });
		expect(parseDepotRef("depot")).toEqual({ path: "//depot", rev: "", folder: true });
		expect(parseDepotRef("depot/main/@12000")).toEqual({ path: "//depot/main", rev: "@12000", folder: true });
	});
});
