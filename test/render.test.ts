import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildTranscript } from "../src/model.ts";
import { prettifyStructuredOutput, renderTranscript, toolDisplayName } from "../src/render.ts";
import { readSessionSnapshot } from "../src/session.ts";
import { plainText } from "../src/styled.ts";
import { CLAUDE_COLORS } from "../src/theme.ts";

const fixturePath = join(import.meta.dir, "fixtures", "representative.jsonl");
const transcript = buildTranscript(readSessionSnapshot(fixturePath).records);

function text(mode: "compact" | "detailed", width = 72): string {
	return renderTranscript(transcript, { width, mode, locale: "en-US", timeZone: "UTC" })
		.lines.map((line) => plainText(line).trimEnd())
		.join("\n");
}

describe("Claude transcript rendering", () => {
	test("groups routine tools in compact mode but keeps skills, updates, and errors visible", () => {
		const output = text("compact");
		expect(output).toContain("Read 1 file");
		expect(output).toContain("Ran 2 shell commands");
		expect(output).not.toContain("Read(/workspace/project/src/demo.ts)");
		expect(output).not.toContain("Bash(bun test)");
		expect(output).toContain("⏺ Skill(review)");
		expect(output).toContain("⏺ Update(/workspace/project/src/demo.ts)");
		expect(output).toContain("1 +const ready = true;");
		expect(output).toContain("Added 1 line, removed 1 line");
		expect(output).toContain('⏺ Bash(bun run missing)\n  ⎿  error: Script not found "missing"');
	});

	test("detailed mode expands tool results and adds timestamps", () => {
		const output = text("detailed");
		expect(output).toContain("08:00 PM claude-synthetic-5");
		expect(output).toContain("⏺ Read(/workspace/project/src/demo.ts)\n  ⎿  Read 2 lines");
		expect(output).toContain("⏺ Bash(bun test)\n  ⎿  2 pass\n     0 fail");
		expect(output).toContain("┌───────┬────────┐");
	});

	test("uses observed Claude colors instead of a host theme", () => {
		const compact = renderTranscript(transcript, { width: 72, mode: "compact" });
		const user = compact.lines[0] ?? [];
		expect(user[0]?.style?.bg).toBe(CLAUDE_COLORS.userBackground);
		const toolLine = compact.lines.find((line) => plainText(line).startsWith("⏺ Skill"));
		expect(toolLine?.[0]?.style?.fg).toBe(CLAUDE_COLORS.tool);
		const addition = compact.lines.find((line) => plainText(line).includes("+const ready"));
		expect(addition?.some((span) => span.style?.bg === CLAUDE_COLORS.diffAddBackground)).toBeTrue();
	});

	test("uses Claude's word-level emphasis for paired edit lines", () => {
		const detailed = renderTranscript(transcript, { width: 72, mode: "detailed" });
		const removal = detailed.lines.find((line) => plainText(line).includes("-const ready = false;"));
		const addition = detailed.lines.find((line) => plainText(line).includes("+const ready = true;"));
		expect(
			removal
				?.filter((span) => span.style?.bg === CLAUDE_COLORS.diffRemoveHighlight)
				.map((span) => span.text)
				.join(""),
		).toBe("false");
		expect(
			addition
				?.filter((span) => span.style?.bg === CLAUDE_COLORS.diffAddHighlight)
				.map((span) => span.text)
				.join(""),
		).toBe("true");
	});

	test("wraps user blocks with a full-width background", () => {
		const compact = renderTranscript(transcript, { width: 36, mode: "compact" });
		const firstPromptEnd = compact.lines.findIndex((line, index) => index > 0 && line.length === 0);
		for (const line of compact.lines.slice(0, firstPromptEnd)) {
			expect(Bun.stringWidth(plainText(line))).toBe(36);
			expect(line.every((span) => span.style?.bg === CLAUDE_COLORS.userBackground)).toBeTrue();
		}
	});

	test("uses Claude's Update label for Edit records", () => {
		expect(toolDisplayName("Edit")).toBe("Update");
		expect(toolDisplayName("Write")).toBe("Write");
	});

	test("pretty-prints each complete JSONL record without losing a truncated record", () => {
		const output = prettifyStructuredOutput('{"first":1}\n{"second":{"nested":true}}\n{"truncated"');
		expect(output).toBe('{\n  "first": 1\n}\n{\n  "second": {\n    "nested": true\n  }\n}\n{"truncated"');
	});
});
