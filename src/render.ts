import { extname } from "node:path";
import { diffWords } from "diff";
import hljs from "highlight.js/lib/common";
import { renderMarkdown } from "./markdown.ts";
import {
	appendSpan,
	concatLines,
	cropLine,
	padLine,
	rightAligned,
	styled,
	textWidth,
	wrapStyledLine,
} from "./styled.ts";
import { CLAUDE_COLORS, CLAUDE_STYLES } from "./theme.ts";
import type {
	AssistantBlock,
	AssistantEvent,
	JsonObject,
	RenderMode,
	StyledLine,
	TextStyle,
	ToolBlock,
	Transcript,
	TranscriptDocument,
} from "./types.ts";

export interface RenderOptions {
	width: number;
	mode?: RenderMode;
	locale?: string;
	timeZone?: string;
}

const DURATION_VERBS = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"];

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function ensureBlank(lines: StyledLine[]): void {
	if (lines.length > 0 && (lines.at(-1)?.length ?? 0) > 0) lines.push([]);
}

function renderUserText(text: string, width: number): StyledLine[] {
	const output: StyledLine[] = [];
	let firstPhysicalLine = true;
	for (const logicalLine of text.split("\n")) {
		const prefix = firstPhysicalLine
			? concatLines(styled("❯", CLAUDE_STYLES.userMarker), styled(" ", { bg: CLAUDE_COLORS.userBackground }))
			: [];
		const wrapped = wrapStyledLine(styled(logicalLine, CLAUDE_STYLES.user), width, {
			firstPrefix: prefix,
			continuationPrefix: [],
			preserveLeadingSpace: true,
		});
		for (const line of wrapped) output.push(padLine(line, width, CLAUDE_STYLES.user));
		firstPhysicalLine = false;
	}
	return output;
}

function modelLabel(model: string | undefined): string {
	if (!model) return "";
	return model.replace(/-\d{8}$/u, "");
}

function timestampLabel(
	timestamp: string | undefined,
	model: string | undefined,
	locale: string,
	timeZone: string | undefined,
): string {
	let time = "";
	if (timestamp) {
		const date = new Date(timestamp);
		if (!Number.isNaN(date.valueOf())) {
			time = new Intl.DateTimeFormat(locale, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: true,
				...(timeZone ? { timeZone } : {}),
			}).format(date);
		}
	}
	return [time, modelLabel(model)].filter(Boolean).join(" ");
}

function stableDurationVerb(id: string): string {
	let hash = 2166136261;
	for (const character of id) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return DURATION_VERBS[Math.abs(hash) % DURATION_VERBS.length] ?? "Worked";
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(1, Math.round(durationMs / 1000));
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function displayToolName(name: string): string {
	return name === "Edit" ? "Update" : name;
}

function compactJson(value: JsonObject): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function toolArgument(block: ToolBlock): string {
	const input = block.input;
	switch (block.name) {
		case "Read": {
			const path = stringValue(input.file_path) ?? stringValue(input.path) ?? compactJson(input);
			const offset = numberValue(input.offset);
			const limit = numberValue(input.limit);
			if (offset !== undefined && limit !== undefined) return `${path} · lines ${offset}-${offset + limit - 1}`;
			if (offset !== undefined) return `${path} · from line ${offset}`;
			return path;
		}
		case "Edit":
		case "Write":
			return stringValue(input.file_path) ?? stringValue(input.path) ?? compactJson(input);
		case "Bash":
			return stringValue(input.command) ?? compactJson(input);
		case "Skill": {
			const skill = stringValue(input.skill) ?? stringValue(input.name) ?? "";
			return skill;
		}
		case "Grep": {
			const pattern = stringValue(input.pattern) ?? "";
			const path = stringValue(input.path);
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "Glob":
			return stringValue(input.pattern) ?? compactJson(input);
		default:
			return compactJson(input);
	}
}

function toolCallContent(block: ToolBlock, argument: string, includeName: boolean, close: boolean): StyledLine {
	const name = displayToolName(block.name);
	const call: StyledLine = [];
	if (includeName) appendSpan(call, name, { bold: true });
	if (argument) {
		if (includeName) appendSpan(call, "(", CLAUDE_STYLES.text);
		if (block.name === "Read" || block.name === "Edit" || block.name === "Write") {
			const separator = argument.indexOf(" · ");
			const path = separator >= 0 ? argument.slice(0, separator) : argument;
			appendSpan(call, path, { underline: true });
			if (separator >= 0) appendSpan(call, argument.slice(separator), CLAUDE_STYLES.text);
		} else {
			appendSpan(call, argument, CLAUDE_STYLES.text);
		}
		if (close) appendSpan(call, ")", CLAUDE_STYLES.text);
	}
	return call;
}

function toolCallLine(block: ToolBlock, width: number): StyledLine[] {
	const argument = toolArgument(block);
	const logicalLines = argument.split("\n");
	const markerStyle = block.result?.isError ? CLAUDE_STYLES.error : CLAUDE_STYLES.tool;
	const output: StyledLine[] = [];
	for (const [index, logicalLine] of logicalLines.entries()) {
		const first = index === 0;
		const last = index === logicalLines.length - 1;
		const prefix = first
			? concatLines(styled("⏺", markerStyle), styled(" ", CLAUDE_STYLES.text))
			: styled("  ", CLAUDE_STYLES.text);
		const content = toolCallContent(block, logicalLine, first, last);
		output.push(
			...wrapStyledLine(content, width, {
				firstPrefix: prefix,
				continuationPrefix: styled("  ", CLAUDE_STYLES.text),
				preserveLeadingSpace: true,
			}),
		);
	}
	if (!argument) {
		return wrapStyledLine(toolCallContent(block, "", true, true), width, {
			firstPrefix: concatLines(styled("⏺", markerStyle), styled(" ", CLAUDE_STYLES.text)),
			continuationPrefix: styled("  ", CLAUDE_STYLES.text),
		});
	}
	return output;
}

function readLineCount(block: ToolBlock): number | undefined {
	const details = block.result?.details;
	const file = details ? objectValue(details.file) : undefined;
	return numberValue(file?.numLines) ?? numberValue(details?.numLines);
}

function resultPrefix(): StyledLine {
	return styled("  ⎿  ", CLAUDE_STYLES.muted);
}

function linkifiedText(text: string, style: TextStyle): StyledLine {
	const output: StyledLine = [];
	const pattern = /https?:\/\/[^\s]+/gu;
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index;
		appendSpan(output, text.slice(cursor, index), style);
		appendSpan(output, match[0], { fg: 12, underline: true });
		cursor = index + match[0].length;
	}
	appendSpan(output, text.slice(cursor), style);
	return output;
}

function renderResultText(
	text: string,
	width: number,
	error: boolean,
	muted = false,
	hard = false,
	splitWhitespace = false,
): StyledLine[] {
	const style = error ? CLAUDE_STYLES.error : muted ? CLAUDE_STYLES.muted : CLAUDE_STYLES.text;
	const output: StyledLine[] = [];
	const logicalLines = text.replace(/\r\n?/gu, "\n").split("\n");
	while (logicalLines.length > 1 && logicalLines.at(-1) === "") logicalLines.pop();
	for (const [index, logicalLine] of logicalLines.entries()) {
		output.push(
			...wrapStyledLine(linkifiedText(logicalLine, style), width, {
				firstPrefix: index === 0 ? resultPrefix() : styled("     ", style),
				continuationPrefix: styled("     ", style),
				hard,
				preserveLeadingSpace: true,
				splitWhitespace,
			}),
		);
	}
	return output;
}

interface PatchHunk {
	oldStart: number;
	newStart: number;
	lines: string[];
}

function patchHunks(details: JsonObject | undefined): PatchHunk[] {
	if (!details || !Array.isArray(details.structuredPatch)) return [];
	const hunks: PatchHunk[] = [];
	for (const raw of details.structuredPatch) {
		const hunk = objectValue(raw);
		if (!hunk || !Array.isArray(hunk.lines)) continue;
		const lines = hunk.lines.filter((line): line is string => typeof line === "string");
		hunks.push({
			oldStart: numberValue(hunk.oldStart) ?? 1,
			newStart: numberValue(hunk.newStart) ?? 1,
			lines,
		});
	}
	return hunks;
}

interface HighlightNode {
	children: Array<string | HighlightNode>;
	scope?: string;
}

interface HighlightResultInternal {
	_emitter?: { rootNode?: HighlightNode };
}

function highlightedStyle(scope: string | undefined, text: string, inherited: TextStyle, base: TextStyle): TextStyle {
	if (!scope || scope === "function") return inherited;
	if (scope === "subst") return base;
	if (scope === "comment") return { ...inherited, fg: CLAUDE_COLORS.codeComment };
	if (scope === "string") return { ...inherited, fg: CLAUDE_COLORS.codeString };
	if (scope === "keyword") {
		return {
			...inherited,
			fg: /^(?:const|let|var)$/u.test(text) ? CLAUDE_COLORS.codeType : CLAUDE_COLORS.codeKeyword,
		};
	}
	if (scope === "literal" || scope === "number") return { ...inherited, fg: CLAUDE_COLORS.codeLiteral };
	if (scope === "property") return { ...inherited, fg: CLAUDE_COLORS.text };
	if (
		scope === "attr" ||
		scope === "built_in" ||
		scope === "title.class" ||
		scope === "title.function" ||
		scope === "title"
	) {
		return { ...inherited, fg: CLAUDE_COLORS.codeFunction };
	}
	return inherited;
}

function highlightNode(node: HighlightNode, output: StyledLine, inherited: TextStyle, base: TextStyle): void {
	const text = node.children
		.map((child) =>
			typeof child === "string" ? child : child.children.filter((item) => typeof item === "string").join(""),
		)
		.join("");
	const style = highlightedStyle(node.scope, text, inherited, base);
	for (const child of node.children) {
		if (typeof child === "string") appendSpan(output, child, style);
		else highlightNode(child, output, style, base);
	}
}

function syntaxSpans(source: string, base: TextStyle, language: string): StyledLine {
	const result = hljs.highlight(source, { language, ignoreIllegals: true }) as unknown as HighlightResultInternal;
	const root = result._emitter?.rootNode;
	if (!root) return styled(source, base);
	const output: StyledLine = [];
	highlightNode(root, output, base, base);
	return output;
}

function patchLanguage(block: ToolBlock): string {
	const path = stringValue(block.result?.details?.filePath) ?? stringValue(block.input.file_path) ?? "";
	const extension = extname(path).toLowerCase();
	const languages: Record<string, string> = {
		".bash": "bash",
		".c": "c",
		".cc": "cpp",
		".cpp": "cpp",
		".css": "css",
		".go": "go",
		".html": "xml",
		".java": "java",
		".js": "javascript",
		".json": "json",
		".jsx": "javascript",
		".md": "markdown",
		".py": "python",
		".rb": "ruby",
		".rs": "rust",
		".sh": "bash",
		".sql": "sql",
		".swift": "swift",
		".ts": "typescript",
		".tsx": "typescript",
		".xml": "xml",
		".yaml": "yaml",
		".yml": "yaml",
	};
	return languages[extension] ?? "plaintext";
}

interface TextRange {
	end: number;
	start: number;
}

function pairedChangeRanges(oldSource: string, newSource: string): { additions: TextRange[]; removals: TextRange[] } {
	const parts = diffWords(oldSource, newSource, { ignoreCase: false });
	const changedLength = parts.reduce((total, part) => total + (part.added || part.removed ? part.value.length : 0), 0);
	if (changedLength / (oldSource.length + newSource.length) > 0.4) {
		return { additions: [], removals: [] };
	}

	const ranges = (addition: boolean): TextRange[] => {
		const output: TextRange[] = [];
		let offset = 0;
		for (const part of parts) {
			const omitted = addition ? part.removed : part.added;
			if (omitted) continue;
			const changed = addition ? part.added : part.removed;
			if (changed) output.push({ start: offset, end: offset + part.value.length });
			offset += part.value.length;
		}
		return output;
	};

	return { additions: ranges(true), removals: ranges(false) };
}

function patchEmphasis(lines: readonly string[]): Map<number, TextRange[]> {
	const emphasis = new Map<number, TextRange[]>();
	let index = 0;
	while (index < lines.length) {
		if (!lines[index]?.startsWith("-")) {
			index++;
			continue;
		}
		const removals: number[] = [];
		while (lines[index]?.startsWith("-")) {
			removals.push(index);
			index++;
		}
		const additions: number[] = [];
		while (lines[index]?.startsWith("+")) {
			additions.push(index);
			index++;
		}
		for (let pair = 0; pair < Math.min(removals.length, additions.length); pair++) {
			const removalIndex = removals[pair];
			const additionIndex = additions[pair];
			if (removalIndex === undefined || additionIndex === undefined) continue;
			const ranges = pairedChangeRanges((lines[removalIndex] ?? "").slice(1), (lines[additionIndex] ?? "").slice(1));
			emphasis.set(removalIndex, ranges.removals);
			emphasis.set(additionIndex, ranges.additions);
		}
	}
	return emphasis;
}

function applyRangeBackground(line: StyledLine, ranges: readonly TextRange[], background: string): StyledLine {
	if (ranges.length === 0) return line;
	const output: StyledLine = [];
	let offset = 0;
	for (const span of line) {
		let spanOffset = 0;
		while (spanOffset < span.text.length) {
			const absolute = offset + spanOffset;
			const range = ranges.find(({ start, end }) => absolute >= start && absolute < end);
			const nextBoundary = range
				? range.end
				: Math.min(
						...ranges.filter(({ start }) => start > absolute).map(({ start }) => start),
						offset + span.text.length,
					);
			const take = Math.max(1, Math.min(span.text.length - spanOffset, nextBoundary - absolute));
			appendSpan(
				output,
				span.text.slice(spanOffset, spanOffset + take),
				range ? { ...span.style, bg: background } : span.style,
			);
			spanOffset += take;
		}
		offset += span.text.length;
	}
	return output;
}

function patchLine(
	number: number,
	marker: string,
	source: string,
	width: number,
	language: string,
	emphasis: readonly TextRange[],
): StyledLine[] {
	const addition = marker === "+";
	const removal = marker === "-";
	const background = addition
		? CLAUDE_COLORS.diffAddBackground
		: removal
			? CLAUDE_COLORS.diffRemoveBackground
			: undefined;
	const numberStyle: TextStyle = background
		? { fg: addition ? CLAUDE_COLORS.diffAdd : CLAUDE_COLORS.diffRemove, bg: background }
		: { fg: CLAUDE_COLORS.code, dim: true };
	const codeStyle: TextStyle = background ? { fg: CLAUDE_COLORS.code, bg: background } : { fg: CLAUDE_COLORS.code };
	const gutter = `${String(number).padStart(4)} ${marker}`;
	let sourceLine = removal ? styled(source, codeStyle) : syntaxSpans(source, codeStyle, language);
	if (background && emphasis.length > 0) {
		sourceLine = applyRangeBackground(
			sourceLine,
			emphasis,
			addition ? CLAUDE_COLORS.diffAddHighlight : CLAUDE_COLORS.diffRemoveHighlight,
		);
	}
	const content = concatLines(styled(gutter, numberStyle), sourceLine);
	const wrapped = wrapStyledLine(content, width, {
		firstPrefix: styled("     "),
		continuationPrefix: styled("           "),
		preserveLeadingSpace: true,
	});
	return background ? wrapped.map((line) => padLine(line, Math.max(1, width - 7), { bg: background })) : wrapped;
}

function renderPatch(block: ToolBlock, width: number): StyledLine[] {
	const output: StyledLine[] = [];
	const language = patchLanguage(block);
	for (const [hunkIndex, hunk] of patchHunks(block.result?.details).entries()) {
		if (hunkIndex > 0) output.push(styled("     ...", CLAUDE_STYLES.muted));
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		const emphasis = patchEmphasis(hunk.lines);
		for (const [lineIndex, rawLine] of hunk.lines.entries()) {
			const marker = rawLine.startsWith("+") ? "+" : rawLine.startsWith("-") ? "-" : " ";
			const source = /^[+\- ]/u.test(rawLine) ? rawLine.slice(1) : rawLine;
			const number = marker === "-" ? oldLine : newLine;
			output.push(...patchLine(number, marker, source, width, language, emphasis.get(lineIndex) ?? []));
			if (marker !== "+") oldLine++;
			if (marker !== "-") newLine++;
		}
	}
	return output;
}

function editSummary(block: ToolBlock): StyledLine | undefined {
	const hunks = patchHunks(block.result?.details);
	let additions = 0;
	let removals = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith("+")) additions++;
			else if (line.startsWith("-")) removals++;
		}
	}
	if (additions === 0 && removals === 0) return undefined;
	const line = resultPrefix();
	const segments: Array<[string, number]> = [];
	if (additions > 0) segments.push(["Added", additions]);
	if (removals > 0) segments.push(["removed", removals]);
	for (const [index, [verb, count]] of segments.entries()) {
		if (index > 0) appendSpan(line, ", ", CLAUDE_STYLES.text);
		appendSpan(line, `${verb} `, CLAUDE_STYLES.text);
		appendSpan(line, String(count), { bold: true });
		appendSpan(line, ` line${count === 1 ? "" : "s"}`, CLAUDE_STYLES.text);
	}
	return line;
}

function prettyJson(value: string): string | undefined {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return undefined;
	}
}

export function prettifyStructuredOutput(content: string): string {
	const complete = prettyJson(content);
	if (complete !== undefined) return complete;
	const lines = content.split("\n");
	if (lines.length < 2) return content;
	let formattedCount = 0;
	const formatted = lines.map((line) => {
		if (!line.trim()) return "";
		const parsed = prettyJson(line);
		if (parsed === undefined) return line;
		formattedCount++;
		return parsed;
	});
	return formattedCount > 0 ? formatted.join("\n") : content;
}

function renderToolResult(block: ToolBlock, width: number): StyledLine[] {
	if (!block.result) return [];
	if (block.name === "Edit") {
		const patch = renderPatch(block, width);
		const summary = editSummary(block);
		if (patch.length > 0) return summary ? [summary, ...patch] : patch;
	}
	if (block.name === "Read") {
		const count = readLineCount(block);
		if (count !== undefined) {
			const line = resultPrefix();
			appendSpan(line, "Read ", CLAUDE_STYLES.text);
			appendSpan(line, String(count), { bold: true });
			appendSpan(line, ` line${count === 1 ? "" : "s"}`, CLAUDE_STYLES.text);
			return [line];
		}
	}
	if (block.name === "Skill" && block.result.details?.success === true) {
		return renderResultText("Successfully loaded skill", width, false);
	}
	const rawContent = block.result.content.trimEnd();
	const content = block.name === "Bash" ? prettifyStructuredOutput(rawContent) : rawContent;
	const structured = block.name === "Bash" && /^[{[]/u.test(rawContent.trimStart());
	if (block.name === "Bash" && (!content || /^\(?Bash completed with no output\)?$/u.test(content))) {
		return renderResultText("(No output)", width, block.result.isError, true);
	}
	if (!content) return [];
	const displayedContent =
		block.name === "Bash" && block.result.isError
			? content.replace(/^Exit code (\d+)(?=\n|$)/u, "Error: Exit code $1")
			: content;
	return renderResultText(displayedContent, width, block.result.isError, false, false, structured);
}

function renderDetailedTool(block: ToolBlock, width: number): StyledLine[] {
	return [...toolCallLine(block, width), ...renderToolResult(block, width)];
}

type CompactToolKind = "read" | "bash";

function compactKind(block: ToolBlock): CompactToolKind | undefined {
	if (block.result?.isError) return undefined;
	if (block.name === "Read") return "read";
	if (block.name === "Bash") return "bash";
	return undefined;
}

function compactSummary(kind: CompactToolKind, count: number): StyledLine {
	const line = styled("  ", CLAUDE_STYLES.muted);
	appendSpan(line, kind === "read" ? "Read " : "Ran ", CLAUDE_STYLES.muted);
	appendSpan(line, String(count), CLAUDE_STYLES.mutedBold);
	appendSpan(
		line,
		kind === "read" ? ` file${count === 1 ? "" : "s"}` : ` shell command${count === 1 ? "" : "s"}`,
		CLAUDE_STYLES.muted,
	);
	return line;
}

function renderAssistantText(text: string, width: number): StyledLine[] {
	const content = renderMarkdown(text, Math.max(1, width - 2));
	const output: StyledLine[] = [];
	let usedBullet = false;
	for (const line of content) {
		if (line.length === 0) {
			output.push([]);
			continue;
		}
		const prefix = usedBullet
			? styled("  ", CLAUDE_STYLES.text)
			: concatLines(styled("⏺", CLAUDE_STYLES.primary), styled(" ", CLAUDE_STYLES.text));
		output.push(concatLines(prefix, line));
		usedBullet = true;
	}
	return output;
}

function renderBlocks(blocks: readonly AssistantBlock[], mode: RenderMode, width: number): StyledLine[] {
	const output: StyledLine[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block) continue;
		if (block.kind === "text") {
			if (output.length > 0) ensureBlank(output);
			output.push(...renderAssistantText(block.text, width));
			continue;
		}

		if (mode === "compact") {
			const kind = compactKind(block);
			if (kind) {
				let count = 1;
				while (index + 1 < blocks.length) {
					const next = blocks[index + 1];
					if (next?.kind !== "tool" || compactKind(next) !== kind) break;
					count++;
					index++;
				}
				if (output.length > 0) ensureBlank(output);
				output.push(compactSummary(kind, count));
				continue;
			}
		}

		if (output.length > 0) ensureBlank(output);
		output.push(...renderDetailedTool(block, width));
	}
	return output;
}

function renderAssistant(
	event: AssistantEvent,
	mode: RenderMode,
	width: number,
	locale: string,
	timeZone: string | undefined,
): StyledLine[] {
	const output: StyledLine[] = [];
	if (mode === "detailed" && event.blocks.some((block) => block.kind === "text")) {
		const label = timestampLabel(event.timestamp, event.model, locale, timeZone);
		if (label) output.push(rightAligned(styled(label, CLAUDE_STYLES.muted), Math.max(1, width - 8)));
	}
	output.push(...renderBlocks(event.blocks, mode, width));
	return output;
}

export function renderTranscript(transcript: Transcript, options: RenderOptions): TranscriptDocument {
	const width = Math.max(12, Math.floor(options.width));
	const mode = options.mode ?? "compact";
	const locale = options.locale ?? "en-US";
	const timeZone = options.timeZone;
	const lines: StyledLine[] = [];
	const promptRows: number[] = [];

	for (const event of transcript.events) {
		switch (event.kind) {
			case "user":
				ensureBlank(lines);
				promptRows.push(lines.length);
				lines.push(...renderUserText(event.text, width));
				break;
			case "assistant": {
				ensureBlank(lines);
				lines.push(...renderAssistant(event, mode, width, locale, timeZone));
				break;
			}
			case "duration": {
				ensureBlank(lines);
				lines.push(
					styled(`✻ ${stableDurationVerb(event.id)} for ${formatDuration(event.durationMs)}`, CLAUDE_STYLES.muted),
				);
				break;
			}
			case "notice": {
				ensureBlank(lines);
				const style =
					event.level === "error"
						? CLAUDE_STYLES.error
						: event.level === "warning"
							? CLAUDE_STYLES.warning
							: CLAUDE_STYLES.muted;
				const content = wrapStyledLine(styled(event.text, style), width, {
					firstPrefix: styled("⏺ ", style),
					continuationPrefix: styled("  ", style),
				});
				lines.push(...content);
				break;
			}
		}
	}

	while (lines.length > 0 && (lines.at(-1)?.length ?? 0) === 0) lines.pop();
	return { lines, promptRows };
}

export function visibleDocument(
	document: TranscriptDocument,
	offset: number,
	height: number,
	width: number,
): StyledLine[] {
	const start = Math.max(0, Math.min(offset, Math.max(0, document.lines.length - height)));
	const output = document.lines.slice(start, start + height).map((line) => cropLine(line, width));
	while (output.length < height) output.push([]);
	return output;
}

export function nearestPrompt(document: TranscriptDocument, currentRow: number, direction: -1 | 1): number | undefined {
	if (direction < 0) {
		for (let index = document.promptRows.length - 1; index >= 0; index--) {
			const row = document.promptRows[index];
			if (row !== undefined && row < currentRow) return row;
		}
		return document.promptRows[0];
	}
	for (const row of document.promptRows) {
		if (row > currentRow) return row;
	}
	return document.promptRows.at(-1);
}

export function toolDisplayName(name: string): string {
	return displayToolName(name);
}

export function measuredToolArgument(block: ToolBlock): number {
	return textWidth(toolArgument(block));
}
