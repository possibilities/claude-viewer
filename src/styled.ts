import type { StyledLine, StyledSpan, TextStyle } from "./types.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function textWidth(text: string): number {
	return Bun.stringWidth(text);
}

export function lineWidth(line: readonly StyledSpan[]): number {
	return line.reduce((width, part) => width + textWidth(part.text), 0);
}

function styleKey(style: TextStyle | undefined): string {
	if (!style) return "";
	return [
		style.fg ?? "",
		style.bg ?? "",
		style.bold ? 1 : 0,
		style.dim ? 1 : 0,
		style.italic ? 1 : 0,
		style.underline ? 1 : 0,
		style.strikethrough ? 1 : 0,
		style.inverse ? 1 : 0,
	].join("\0");
}

export function appendSpan(line: StyledLine, text: string, style?: TextStyle): void {
	if (!text) return;
	const previous = line.at(-1);
	if (previous && styleKey(previous.style) === styleKey(style)) {
		previous.text += text;
		return;
	}
	line.push(style ? { text, style } : { text });
}

export function styled(text: string, style?: TextStyle): StyledLine {
	return text ? [style ? { text, style } : { text }] : [];
}

export function concatLines(...parts: readonly (readonly StyledSpan[])[]): StyledLine {
	const result: StyledLine = [];
	for (const part of parts) {
		for (const span of part) appendSpan(result, span.text, span.style);
	}
	return result;
}

export function plainText(line: readonly StyledSpan[]): string {
	return line.map((part) => part.text).join("");
}

export function padLine(line: readonly StyledSpan[], width: number, style?: TextStyle): StyledLine {
	const result = concatLines(line);
	appendSpan(result, " ".repeat(Math.max(0, width - lineWidth(result))), style);
	return result;
}

export function rightAligned(content: readonly StyledSpan[], width: number): StyledLine {
	return concatLines(styled(" ".repeat(Math.max(0, width - lineWidth(content)))), content);
}

interface Chunk {
	text: string;
	style: TextStyle | undefined;
	space: boolean;
}

function chunksForLine(line: readonly StyledSpan[]): Chunk[] {
	const chunks: Chunk[] = [];
	for (const part of line) {
		for (const match of part.text.matchAll(/\s+|\S+/gu)) {
			const text = match[0];
			chunks.push({ text, style: part.style, space: /^\s+$/u.test(text) });
		}
	}
	return chunks;
}

function takeWidth(text: string, maximum: number): [string, string] {
	if (maximum <= 0) return ["", text];
	let used = 0;
	let taken = "";
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const width = textWidth(segment);
		if (taken && used + width > maximum) break;
		if (!taken && width > maximum) return [segment, text.slice(segment.length)];
		if (used + width > maximum) break;
		taken += segment;
		used += width;
	}
	return [taken, text.slice(taken.length)];
}

function sliceStyledLine(line: readonly StyledSpan[], start: number, end: number): StyledLine {
	const output: StyledLine = [];
	let offset = 0;
	for (const span of line) {
		const spanEnd = offset + span.text.length;
		const sliceStart = Math.max(start, offset);
		const sliceEnd = Math.min(end, spanEnd);
		if (sliceStart < sliceEnd) {
			appendSpan(output, span.text.slice(sliceStart - offset, sliceEnd - offset), span.style);
		}
		offset = spanEnd;
		if (offset >= end) break;
	}
	return output;
}

export interface WrapOptions {
	firstPrefix?: StyledLine;
	continuationPrefix?: StyledLine;
	hard?: boolean;
	preserveLeadingSpace?: boolean;
	splitWhitespace?: boolean;
}

export function wrapStyledLine(line: readonly StyledSpan[], width: number, options: WrapOptions = {}): StyledLine[] {
	const safeWidth = Math.max(1, width);
	const firstPrefix = options.firstPrefix ?? [];
	const continuationPrefix = options.continuationPrefix ?? firstPrefix;
	const firstCapacity = Math.max(1, safeWidth - lineWidth(firstPrefix));
	const continuationCapacity = Math.max(1, safeWidth - lineWidth(continuationPrefix));
	if (options.splitWhitespace && firstCapacity === continuationCapacity) {
		const source = plainText(line);
		const wrapped = Bun.wrapAnsi(source, firstCapacity, { trim: false, hard: true }).split("\n");
		let offset = 0;
		return wrapped.map((part, index) => {
			const consumedBoundarySpace = index > 0 && part.startsWith(" ") ? 1 : 0;
			const content = sliceStyledLine(line, offset + consumedBoundarySpace, offset + part.length);
			offset += part.length;
			return concatLines(index === 0 ? firstPrefix : continuationPrefix, content);
		});
	}
	const output: StyledLine[] = [];
	let current = concatLines(firstPrefix);
	let prefixWidth = lineWidth(current);

	const nextLine = (): void => {
		output.push(current);
		current = concatLines(continuationPrefix);
		prefixWidth = lineWidth(current);
	};

	if (options.hard) {
		for (const part of line) {
			for (const { segment } of graphemeSegmenter.segment(part.text)) {
				const segmentWidth = textWidth(segment);
				const currentWidth = lineWidth(current);
				if (currentWidth > prefixWidth && currentWidth + segmentWidth > safeWidth) nextLine();
				appendSpan(current, segment, part.style);
			}
		}
		output.push(current);
		return output;
	}

	for (const chunk of chunksForLine(line)) {
		let remaining = chunk.text;
		if (chunk.space && !options.preserveLeadingSpace && lineWidth(current) <= prefixWidth) continue;

		while (remaining) {
			const currentWidth = lineWidth(current);
			if (currentWidth >= safeWidth && currentWidth > prefixWidth) {
				nextLine();
				if (chunk.space) break;
				continue;
			}
			if (chunk.space && !options.preserveLeadingSpace && lineWidth(current) <= prefixWidth) break;
			const available = Math.max(1, safeWidth - lineWidth(current));
			const remainingWidth = textWidth(remaining);
			if (chunk.space && remainingWidth > available && currentWidth > prefixWidth) {
				nextLine();
				break;
			}
			if (remainingWidth <= available) {
				appendSpan(current, remaining, chunk.style);
				break;
			}

			if (!chunk.space && lineWidth(current) > prefixWidth && remainingWidth <= continuationCapacity) {
				nextLine();
				continue;
			}

			const [head, tail] = takeWidth(remaining, available);
			appendSpan(current, head, chunk.style);
			remaining = tail;
			if (remaining) nextLine();
		}
	}

	output.push(current);
	return output;
}

export function cropLine(line: readonly StyledSpan[], width: number): StyledLine {
	const result: StyledLine = [];
	let remaining = Math.max(0, width);
	for (const part of line) {
		if (remaining <= 0) break;
		const [head] = takeWidth(part.text, remaining);
		appendSpan(result, head, part.style);
		remaining -= textWidth(head);
	}
	return result;
}

function colorCodes(color: string | number, background: boolean): number[] {
	const base = background ? 48 : 38;
	if (typeof color === "number") return [base, 5, color];
	const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(color);
	if (!match) return [];
	return [
		base,
		2,
		Number.parseInt(match[1] ?? "00", 16),
		Number.parseInt(match[2] ?? "00", 16),
		Number.parseInt(match[3] ?? "00", 16),
	];
}

export function styleSequence(style: TextStyle | undefined): string {
	if (!style) return "\x1b[0m";
	const codes: number[] = [0];
	if (style.bold) codes.push(1);
	if (style.dim) codes.push(2);
	if (style.italic) codes.push(3);
	if (style.underline) codes.push(4);
	if (style.inverse) codes.push(7);
	if (style.strikethrough) codes.push(9);
	if (style.fg !== undefined) codes.push(...colorCodes(style.fg, false));
	if (style.bg !== undefined) codes.push(...colorCodes(style.bg, true));
	return `\x1b[${codes.join(";")}m`;
}

export function ansiLine(line: readonly StyledSpan[]): string {
	let output = "";
	let previous = "<unset>";
	for (const part of line) {
		const key = styleKey(part.style);
		if (key !== previous) {
			output += styleSequence(part.style);
			previous = key;
		}
		output += part.text;
	}
	return `${output}\x1b[0m`;
}

export function ansiDocument(lines: readonly StyledLine[]): string {
	return lines.map(ansiLine).join("\r\n");
}
