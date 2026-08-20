import { describe, expect, test } from "bun:test";
import { ansiLine, cropLine, plainText, styled, wrapStyledLine } from "../src/styled.ts";

describe("styled lines", () => {
	test("wraps words while preserving prefixes and wide graphemes", () => {
		const lines = wrapStyledLine(styled("alpha 界🙂 omega", { fg: "#ffffff" }), 10, {
			firstPrefix: styled("⏺ ", { fg: "#4eba65" }),
			continuationPrefix: styled("  "),
		});
		expect(lines.map(plainText)).toEqual(["⏺ alpha ", "  界🙂 ", "  omega"]);
		expect(lines.every((line) => Bun.stringWidth(plainText(line)) <= 10)).toBeTrue();
	});

	test("hard-wraps structured output at the terminal boundary", () => {
		const lines = wrapStyledLine(styled('      "path": "/very/long/path"'), 20, {
			firstPrefix: styled("     "),
			continuationPrefix: styled("     "),
			hard: true,
		});
		expect(lines.map(plainText)).toEqual(['           "path": "', "     /very/long/path", '     "']);
	});

	test("fills the current row before splitting a word longer than the continuation width", () => {
		const lines = wrapStyledLine(styled('"path": "/a/very/long/unbroken/path"'), 20, {
			firstPrefix: styled("     "),
			continuationPrefix: styled("     "),
		});
		expect(lines.map(plainText)).toEqual(['     "path": "/a/ver', "     y/long/unbroken", '     /path"']);
	});

	test("wraps structured output with Claude's Bun boundary semantics", () => {
		const lines = wrapStyledLine(styled("No header row, no footer row, no pinned rail", { fg: "#ffffff" }), 40, {
			firstPrefix: styled("     "),
			continuationPrefix: styled("     "),
			preserveLeadingSpace: true,
			splitWhitespace: true,
		});
		expect(lines.map(plainText)).toEqual(["     No header row, no footer row, no ", "     pinned rail"]);
		expect(lines[1]?.at(-1)?.style?.fg).toBe("#ffffff");
	});

	test("crops by terminal width without splitting an emoji", () => {
		expect(plainText(cropLine(styled("ab🙂cd"), 4))).toBe("ab🙂");
	});

	test("emits true-color ANSI sequences", () => {
		expect(ansiLine(styled("Claude", { fg: "#4eba65", bold: true }))).toContain("\x1b[0;1;38;2;78;186;101mClaude");
	});
});
