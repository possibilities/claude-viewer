import { describe, expect, test } from "bun:test";
import { compareFrames, cropOracleTranscript, frameFromAnsi, frameFromStyledLines, frameText } from "../src/frame.ts";
import { padLine, styled } from "../src/styled.ts";
import { CLAUDE_COLORS } from "../src/theme.ts";

describe("terminal frames", () => {
	test("extracts RGB colors from ANSI", async () => {
		const frame = await frameFromAnsi("\x1b[38;2;78;186;101m⏺\x1b[0m", 10, 1);
		expect(frame.rows[0]?.[0]).toMatchObject({ text: "⏺", fg: CLAUDE_COLORS.tool });
	});

	test("crops Claude startup and transcript footer chrome", () => {
		const userStyle = { fg: "#ffffff", bg: CLAUDE_COLORS.userBackground };
		const frame = frameFromStyledLines(
			[
				styled("Claude Code v2.1.235"),
				[],
				padLine(styled("❯ synthetic prompt", userStyle), 40, userStyle),
				styled("⏺ answer"),
				styled("────────────────────────────────────────"),
				styled("Showing detailed transcript · ctrl+o to toggle"),
			],
			40,
		);
		const cropped = cropOracleTranscript(frame);
		expect(frameText(cropped)).toBe("❯ synthetic prompt\n⏺ answer");
		expect(cropped.metadata).toMatchObject({ cropped: true, cropStart: 2, cropEnd: 4 });
	});

	test("normalizes Claude's volatile duration verb", () => {
		const expected = frameFromStyledLines([styled("✻ Baked for 12s", { fg: "#999999" })], 40);
		const actual = frameFromStyledLines([styled("✻ Cogitated for 12s", { fg: "#999999" })], 40);
		expect(compareFrames(expected, actual)).toMatchObject({ match: true, matchingTextRows: 1 });
	});

	test("reports style drift independently from text drift", () => {
		const expected = frameFromStyledLines([styled("same", { fg: "#ffffff" })], 20);
		const actual = frameFromStyledLines([styled("same", { fg: "#999999" })], 20);
		const comparison = compareFrames(expected, actual);
		expect(comparison).toMatchObject({ match: false, matchingTextRows: 1, styleMismatchRows: 1 });
		expect(comparison.differences[0]?.kind).toBe("style");
	});

	test("pairs adjacent removals and additions as changed rows", () => {
		const expected = frameFromStyledLines([styled("one"), styled("old"), styled("three")], 20);
		const actual = frameFromStyledLines([styled("one"), styled("new"), styled("three")], 20);
		const comparison = compareFrames(expected, actual);
		expect(comparison.differences).toEqual([
			expect.objectContaining({
				kind: "changed",
				expectedRow: 1,
				actualRow: 1,
				expectedText: "old",
				actualText: "new",
			}),
		]);
	});
});
