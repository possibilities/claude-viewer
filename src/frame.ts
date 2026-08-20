import { readFileSync } from "node:fs";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { diffArrays } from "diff";
import { CLAUDE_COLORS } from "./theme.ts";
import type { FrameCell, FrameComparison, FrameDifference, StyledLine, TerminalFrame, TextStyle } from "./types.ts";

const XtermTerminal = xterm.Terminal;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DURATION_VERBS = "Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked";
const DURATION_PATTERN = new RegExp(`(✻\\s+)(?:${DURATION_VERBS})(\\s+for\\s+)`, "gu");

type XtermBuffer = XtermTerminalType["buffer"]["normal"];

function hexColor(value: number): string {
	return `#${value.toString(16).padStart(6, "0")}`;
}

function xtermColor(
	cell: NonNullable<ReturnType<NonNullable<ReturnType<XtermBuffer["getLine"]>>["getCell"]>>,
	foreground: boolean,
): string | undefined {
	if (foreground) {
		if (cell.isFgRGB()) return hexColor(cell.getFgColor());
		if (cell.isFgPalette()) return `palette:${cell.getFgColor()}`;
		return undefined;
	}
	if (cell.isBgRGB()) return hexColor(cell.getBgColor());
	if (cell.isBgPalette()) return `palette:${cell.getBgColor()}`;
	return undefined;
}

function frameCellFromXterm(
	cell: NonNullable<ReturnType<NonNullable<ReturnType<XtermBuffer["getLine"]>>["getCell"]>>,
): FrameCell | undefined {
	if (cell.getWidth() === 0) return undefined;
	const frameCell: FrameCell = {
		text: cell.getChars() || " ",
		width: cell.getWidth(),
	};
	const fg = xtermColor(cell, true);
	const bg = xtermColor(cell, false);
	if (fg) frameCell.fg = fg;
	if (bg) frameCell.bg = bg;
	if (cell.isBold()) frameCell.bold = true;
	if (cell.isDim()) frameCell.dim = true;
	if (cell.isItalic()) frameCell.italic = true;
	if (cell.isUnderline()) frameCell.underline = true;
	if (cell.isStrikethrough()) frameCell.strikethrough = true;
	if (cell.isInverse()) frameCell.inverse = true;
	return frameCell;
}

function meaningfulCell(cell: FrameCell): boolean {
	return (
		cell.text.trim().length > 0 ||
		cell.fg !== undefined ||
		cell.bg !== undefined ||
		cell.bold === true ||
		cell.dim === true ||
		cell.italic === true ||
		cell.underline === true ||
		cell.strikethrough === true ||
		cell.inverse === true
	);
}

export function frameFromXtermBuffer(
	buffer: XtermBuffer,
	width: number,
	metadata: TerminalFrame["metadata"] = {},
): TerminalFrame {
	const rows: FrameCell[][] = [];
	for (let rowIndex = 0; rowIndex < buffer.length; rowIndex++) {
		const source = buffer.getLine(rowIndex);
		const row: FrameCell[] = [];
		if (source) {
			for (let column = 0; column < source.length; column++) {
				const sourceCell = source.getCell(column);
				if (!sourceCell) continue;
				const cell = frameCellFromXterm(sourceCell);
				if (cell) row.push(cell);
			}
		}
		while (row.length > 0 && !meaningfulCell(row.at(-1) as FrameCell)) row.pop();
		rows.push(row);
	}
	return { schemaVersion: 1, width, height: rows.length, rows, metadata };
}

function styleColor(color: string | number | undefined): string | undefined {
	if (typeof color === "number") return `palette:${color}`;
	return color?.toLowerCase();
}

function frameCellFromStyle(text: string, width: number, style: TextStyle | undefined): FrameCell {
	const cell: FrameCell = { text, width };
	const fg = styleColor(style?.fg);
	const bg = styleColor(style?.bg);
	if (fg) cell.fg = fg;
	if (bg) cell.bg = bg;
	if (style?.bold) cell.bold = true;
	if (style?.dim) cell.dim = true;
	if (style?.italic) cell.italic = true;
	if (style?.underline) cell.underline = true;
	if (style?.strikethrough) cell.strikethrough = true;
	if (style?.inverse) cell.inverse = true;
	return cell;
}

export function frameFromStyledLines(
	lines: readonly StyledLine[],
	width: number,
	metadata: TerminalFrame["metadata"] = {},
): TerminalFrame {
	const rows = lines.map((line) => {
		const row: FrameCell[] = [];
		for (const span of line) {
			for (const { segment } of segmenter.segment(span.text)) {
				row.push(frameCellFromStyle(segment, Bun.stringWidth(segment), span.style));
			}
		}
		while (row.length > 0 && !meaningfulCell(row.at(-1) as FrameCell)) row.pop();
		return row;
	});
	return { schemaVersion: 1, width, height: rows.length, rows, metadata };
}

export async function frameFromAnsi(
	ansi: string,
	width: number,
	height: number,
	metadata: TerminalFrame["metadata"] = {},
): Promise<TerminalFrame> {
	const terminal = new XtermTerminal({
		cols: width,
		rows: Math.max(1, height),
		scrollback: Math.max(1000, height * 2),
		disableStdin: true,
		allowProposedApi: true,
	});
	await new Promise<void>((resolve) => terminal.write(ansi, resolve));
	const frame = frameFromXtermBuffer(terminal.buffer.normal, width, metadata);
	terminal.dispose();
	return frame;
}

export function frameRowText(row: readonly FrameCell[]): string {
	return row
		.map((cell) => cell.text)
		.join("")
		.trimEnd();
}

export function frameText(frame: TerminalFrame): string {
	return frame.rows.map(frameRowText).join("\n");
}

function normalizedText(text: string): string {
	return text.replaceAll("\u00a0", " ").replace(DURATION_PATTERN, "$1Worked$2").trimEnd();
}

function rowHasBackground(row: readonly FrameCell[], color: string): boolean {
	return row.some((cell) => cell.bg?.toLowerCase() === color.toLowerCase());
}

function separatorRow(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 8 && /^─+$/u.test(trimmed);
}

export function cropOracleTranscript(frame: TerminalFrame): TerminalFrame {
	if (frame.metadata.cropped === true) return frame;
	const texts = frame.rows.map(frameRowText);
	let footer = -1;
	for (let index = texts.length - 1; index >= 0; index--) {
		if (texts[index]?.includes("Showing detailed transcript")) {
			footer = index;
			break;
		}
	}
	let end = footer >= 0 ? footer : texts.length;
	while (end > 0 && (!texts[end - 1]?.trim() || separatorRow(texts[end - 1] ?? ""))) end--;

	let start = 0;
	for (let index = 0; index < end; index++) {
		const text = texts[index] ?? "";
		if (text.trimStart().startsWith("❯") && rowHasBackground(frame.rows[index] ?? [], CLAUDE_COLORS.userBackground)) {
			start = index;
			break;
		}
	}
	if (start === 0) {
		const header = texts.findIndex((text) => text.includes("Claude Code"));
		for (let index = Math.max(0, header + 1); index < end; index++) {
			if (texts[index]?.trimStart().startsWith("❯")) {
				start = index;
				break;
			}
		}
	}
	while (start < end && !texts[start]?.trim()) start++;
	const rows = frame.rows.slice(start, end);
	return {
		schemaVersion: 1,
		width: frame.width,
		height: rows.length,
		rows,
		metadata: { ...frame.metadata, cropped: true, cropStart: start, cropEnd: end },
	};
}

function rowStyleSignature(row: readonly FrameCell[]): string {
	return row.map((cell) => [cell.text, cell.width, cellStyle(cell)].join("\0")).join("\x01");
}

function cellStyle(cell: FrameCell | undefined): string {
	if (!cell) return "missing";
	const blank = cell.text.trim().length === 0;
	return [
		!blank && cell.fg ? `fg=${cell.fg}` : "fg=default",
		cell.bg ? `bg=${cell.bg}` : "bg=default",
		!blank && cell.bold ? "bold" : "",
		!blank && cell.dim ? "dim" : "",
		!blank && cell.italic ? "italic" : "",
		cell.underline ? "underline" : "",
		!blank && cell.strikethrough ? "strike" : "",
		cell.inverse ? "inverse" : "",
	]
		.filter(Boolean)
		.join(",");
}

function firstStyleDifference(
	expected: readonly FrameCell[] | undefined,
	actual: readonly FrameCell[] | undefined,
): { expectedStyle: string; actualStyle: string } | undefined {
	const length = Math.max(expected?.length ?? 0, actual?.length ?? 0);
	for (let index = 0; index < length; index++) {
		const expectedCell = expected?.[index];
		const actualCell = actual?.[index];
		if (expectedCell?.text !== actualCell?.text || cellStyle(expectedCell) !== cellStyle(actualCell)) {
			return { expectedStyle: cellStyle(expectedCell), actualStyle: cellStyle(actualCell) };
		}
	}
	return undefined;
}

function difference(
	kind: FrameDifference["kind"],
	expectedRow: number | undefined,
	actualRow: number | undefined,
	expected: TerminalFrame,
	actual: TerminalFrame,
): FrameDifference {
	const expectedCells = expectedRow === undefined ? undefined : expected.rows[expectedRow];
	const actualCells = actualRow === undefined ? undefined : actual.rows[actualRow];
	const styleDifference = kind === "style" ? firstStyleDifference(expectedCells, actualCells) : undefined;
	return {
		kind,
		expectedRow,
		actualRow,
		expectedText: expectedCells ? frameRowText(expectedCells) : undefined,
		actualText: actualCells ? frameRowText(actualCells) : undefined,
		...(styleDifference ?? {}),
	};
}

export function compareFrames(expected: TerminalFrame, actual: TerminalFrame, differenceLimit = 200): FrameComparison {
	const expectedText = expected.rows.map((row) => normalizedText(frameRowText(row)));
	const actualText = actual.rows.map((row) => normalizedText(frameRowText(row)));
	const parts = diffArrays(expectedText, actualText);
	const differences: FrameDifference[] = [];
	let expectedRow = 0;
	let actualRow = 0;
	let matchingTextRows = 0;
	let textMismatchRows = 0;
	let styleMismatchRows = 0;
	let differenceCount = 0;

	for (let partIndex = 0; partIndex < parts.length; partIndex++) {
		const part = parts[partIndex];
		if (!part) continue;
		if (!part.added && !part.removed) {
			for (let index = 0; index < part.value.length; index++) {
				matchingTextRows++;
				const expectedCells = expected.rows[expectedRow] ?? [];
				const actualCells = actual.rows[actualRow] ?? [];
				const durationRow = part.value[index]?.includes("✻ Worked for") === true;
				if (!durationRow && rowStyleSignature(expectedCells) !== rowStyleSignature(actualCells)) {
					styleMismatchRows++;
					differenceCount++;
					if (differences.length < differenceLimit) {
						differences.push(difference("style", expectedRow, actualRow, expected, actual));
					}
				}
				expectedRow++;
				actualRow++;
			}
			continue;
		}

		if (part.removed && parts[partIndex + 1]?.added) {
			const added = parts[partIndex + 1];
			if (!added) continue;
			const paired = Math.min(part.value.length, added.value.length);
			for (let index = 0; index < paired; index++) {
				textMismatchRows++;
				differenceCount++;
				if (differences.length < differenceLimit) {
					differences.push(difference("changed", expectedRow, actualRow, expected, actual));
				}
				expectedRow++;
				actualRow++;
			}
			for (let index = paired; index < part.value.length; index++) {
				textMismatchRows++;
				differenceCount++;
				if (differences.length < differenceLimit) {
					differences.push(difference("removed", expectedRow, undefined, expected, actual));
				}
				expectedRow++;
			}
			for (let index = paired; index < added.value.length; index++) {
				textMismatchRows++;
				differenceCount++;
				if (differences.length < differenceLimit) {
					differences.push(difference("added", undefined, actualRow, expected, actual));
				}
				actualRow++;
			}
			partIndex++;
			continue;
		}

		for (const _value of part.value) {
			textMismatchRows++;
			differenceCount++;
			if (part.removed) {
				if (differences.length < differenceLimit) {
					differences.push(difference("removed", expectedRow, undefined, expected, actual));
				}
				expectedRow++;
			} else {
				if (differences.length < differenceLimit) {
					differences.push(difference("added", undefined, actualRow, expected, actual));
				}
				actualRow++;
			}
		}
	}

	return {
		match: differenceCount === 0,
		expectedRows: expected.rows.length,
		actualRows: actual.rows.length,
		matchingTextRows,
		textMismatchRows,
		styleMismatchRows,
		differenceCount,
		differences,
	};
}

export function readFrame(path: string): TerminalFrame {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error(`Invalid terminal frame: ${path}`);
	const candidate = parsed as Partial<TerminalFrame>;
	if (candidate.schemaVersion !== 1 || typeof candidate.width !== "number" || !Array.isArray(candidate.rows)) {
		throw new Error(`Unsupported terminal frame: ${path}`);
	}
	return {
		schemaVersion: 1,
		width: candidate.width,
		height: candidate.rows.length,
		rows: candidate.rows,
		metadata: candidate.metadata ?? {},
	};
}

export function comparisonText(comparison: FrameComparison): string {
	const summary = comparison.match
		? `match (${comparison.actualRows} rows)`
		: `different (${comparison.textMismatchRows} text mismatches, ${comparison.styleMismatchRows} style mismatches)`;
	const details = comparison.differences.slice(0, 20).map((item) => {
		const location = `expected ${item.expectedRow ?? "-"}, actual ${item.actualRow ?? "-"}`;
		if (item.kind === "style") {
			return `style ${location}: ${item.expectedStyle ?? "?"} → ${item.actualStyle ?? "?"}: ${item.actualText ?? ""}`;
		}
		return `${item.kind} ${location}: ${item.expectedText ?? "∅"} → ${item.actualText ?? "∅"}`;
	});
	return [summary, ...details].join("\n");
}
