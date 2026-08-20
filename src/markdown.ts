import { Lexer, type Token, type Tokens } from "marked";
import { appendSpan, concatLines, lineWidth, padLine, plainText, styled, textWidth, wrapStyledLine } from "./styled.ts";
import { CLAUDE_STYLES } from "./theme.ts";
import type { StyledLine, TextStyle } from "./types.ts";

function mergedStyle(base: TextStyle | undefined, extra: TextStyle): TextStyle {
	return { ...base, ...extra };
}

function renderInlineTokens(tokens: readonly Token[], inherited?: TextStyle): StyledLine {
	const result: StyledLine = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text":
			case "escape": {
				const textToken = token as Tokens.Text | Tokens.Escape;
				if ("tokens" in textToken && Array.isArray(textToken.tokens)) {
					for (const span of renderInlineTokens(textToken.tokens, inherited)) appendSpan(result, span.text, span.style);
				} else {
					appendSpan(result, textToken.text, inherited ?? CLAUDE_STYLES.text);
				}
				break;
			}
			case "strong": {
				const strong = token as Tokens.Strong;
				for (const span of renderInlineTokens(strong.tokens, mergedStyle(inherited, { bold: true }))) {
					appendSpan(result, span.text, span.style);
				}
				break;
			}
			case "em": {
				const emphasis = token as Tokens.Em;
				for (const span of renderInlineTokens(emphasis.tokens, mergedStyle(inherited, { italic: true }))) {
					appendSpan(result, span.text, span.style);
				}
				break;
			}
			case "del": {
				const deleted = token as Tokens.Del;
				for (const span of renderInlineTokens(deleted.tokens, mergedStyle(inherited, { strikethrough: true }))) {
					appendSpan(result, span.text, span.style);
				}
				break;
			}
			case "codespan": {
				appendSpan(result, (token as Tokens.Codespan).text, mergedStyle(inherited, CLAUDE_STYLES.link));
				break;
			}
			case "link": {
				const link = token as Tokens.Link;
				for (const span of renderInlineTokens(link.tokens, mergedStyle(inherited, CLAUDE_STYLES.link))) {
					appendSpan(result, span.text, span.style);
				}
				break;
			}
			case "image": {
				const image = token as Tokens.Image;
				appendSpan(result, image.text || image.href, mergedStyle(inherited, CLAUDE_STYLES.link));
				break;
			}
			case "br":
				appendSpan(result, " ", inherited ?? CLAUDE_STYLES.text);
				break;
			case "html": {
				const html = token as Tokens.HTML;
				const visible = html.text.replace(/<[^>]+>/gu, "");
				appendSpan(result, visible, inherited ?? CLAUDE_STYLES.text);
				break;
			}
			default: {
				const fallback = token as Token & { text?: string; tokens?: Token[] };
				if (fallback.tokens) {
					for (const span of renderInlineTokens(fallback.tokens, inherited)) appendSpan(result, span.text, span.style);
				} else if (fallback.text) {
					appendSpan(result, fallback.text, inherited ?? CLAUDE_STYLES.text);
				}
			}
		}
	}
	return result;
}

export function renderInline(markdown: string, style?: TextStyle): StyledLine {
	return renderInlineTokens(Lexer.lexInline(markdown), style);
}

function pushBlank(lines: StyledLine[]): void {
	if (lines.length > 0 && (lines.at(-1)?.length ?? 0) > 0) lines.push([]);
}

function textLines(text: string, width: number, style: TextStyle): StyledLine[] {
	return text.split("\n").flatMap((line) => wrapStyledLine(styled(line, style), width, { preserveLeadingSpace: true }));
}

function renderTable(token: Tokens.Table, width: number): StyledLine[] {
	const header = token.header.map((cell) => renderInlineTokens(cell.tokens));
	const rows = token.rows.map((row) => row.map((cell) => renderInlineTokens(cell.tokens)));
	const allRows = [header, ...rows];
	const columnCount = Math.max(1, header.length);
	const columnWidths = Array.from({ length: columnCount }, (_, column) =>
		Math.max(3, ...allRows.map((row) => lineWidth(row[column] ?? []) + 2)),
	);
	const borderWidth = columnCount + 1;
	while (columnWidths.reduce((sum, value) => sum + value, borderWidth) > width) {
		let widest = 0;
		for (let index = 1; index < columnWidths.length; index++) {
			if ((columnWidths[index] ?? 0) > (columnWidths[widest] ?? 0)) widest = index;
		}
		if ((columnWidths[widest] ?? 0) <= 5) break;
		columnWidths[widest] = (columnWidths[widest] ?? 0) - 1;
	}

	const border = (left: string, join: string, right: string): StyledLine =>
		styled(`${left}${columnWidths.map((value) => "─".repeat(value)).join(join)}${right}`, CLAUDE_STYLES.text);
	const output: StyledLine[] = [border("┌", "┬", "┐")];
	for (const [rowIndex, row] of allRows.entries()) {
		const wrappedCells = columnWidths.map((columnWidth, column) => {
			const source = row[column] ?? [];
			return wrapStyledLine(source, Math.max(1, columnWidth - 2));
		});
		const height = Math.max(...wrappedCells.map((cell) => cell.length));
		for (let lineIndex = 0; lineIndex < height; lineIndex++) {
			const line = styled("│", CLAUDE_STYLES.text);
			for (let column = 0; column < columnWidths.length; column++) {
				const columnWidth = columnWidths[column] ?? 3;
				const content = wrappedCells[column]?.[lineIndex] ?? [];
				const available = columnWidth - 2;
				const alignment = rowIndex === 0 ? "center" : token.align[column];
				const padding = Math.max(0, available - lineWidth(content));
				const left = alignment === "center" ? Math.floor(padding / 2) : alignment === "right" ? padding : 0;
				const right = padding - left;
				for (const part of concatLines(styled(` ${" ".repeat(left)}`), content, styled(`${" ".repeat(right)} `))) {
					appendSpan(line, part.text, part.style);
				}
				appendSpan(line, "│", CLAUDE_STYLES.text);
			}
			output.push(line);
		}
		if (rowIndex < allRows.length - 1) output.push(border("├", "┼", "┤"));
	}
	output.push(border("└", "┴", "┘"));
	return output;
}

function renderList(token: Tokens.List, width: number): StyledLine[] {
	const output: StyledLine[] = [];
	for (const [index, item] of token.items.entries()) {
		const marker = token.ordered ? `${(token.start || 1) + index}. ` : "- ";
		const itemLines = renderTokens(item.tokens, Math.max(1, width - textWidth(marker)));
		const nonEmpty = itemLines.length > 0 ? itemLines : [[]];
		for (const [lineIndex, line] of nonEmpty.entries()) {
			const prefix = lineIndex === 0 ? marker : " ".repeat(textWidth(marker));
			output.push(concatLines(styled(prefix, CLAUDE_STYLES.text), line));
		}
	}
	return output;
}

function renderTokens(tokens: readonly Token[], width: number): StyledLine[] {
	const output: StyledLine[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "space":
				pushBlank(output);
				break;
			case "paragraph":
			case "text": {
				const block = token as Tokens.Paragraph | Tokens.Text;
				const inline = renderInlineTokens(block.tokens ?? Lexer.lexInline(block.text));
				output.push(...wrapStyledLine(inline, width));
				break;
			}
			case "heading": {
				const heading = token as Tokens.Heading;
				output.push(...wrapStyledLine(renderInlineTokens(heading.tokens, { bold: true }), width));
				break;
			}
			case "code": {
				const code = token as Tokens.Code;
				output.push(...textLines(code.text, width, CLAUDE_STYLES.code));
				break;
			}
			case "blockquote": {
				const quote = token as Tokens.Blockquote;
				for (const line of renderTokens(quote.tokens, Math.max(1, width - 2))) {
					output.push(concatLines(styled("│ ", CLAUDE_STYLES.muted), line));
				}
				break;
			}
			case "list":
				output.push(...renderList(token as Tokens.List, width));
				break;
			case "table":
				output.push(...renderTable(token as Tokens.Table, width));
				break;
			case "hr":
				output.push(styled("─".repeat(width), CLAUDE_STYLES.muted));
				break;
			case "html": {
				const html = (token as Tokens.HTML).text.replace(/<[^>]+>/gu, "").trim();
				if (html) output.push(...wrapStyledLine(styled(html, CLAUDE_STYLES.text), width));
				break;
			}
			default: {
				const fallback = token as Token & { text?: string; tokens?: Token[] };
				if (fallback.tokens) output.push(...renderTokens(fallback.tokens, width));
				else if (fallback.text) output.push(...wrapStyledLine(renderInline(fallback.text), width));
			}
		}
	}
	while (output.length > 0 && (output.at(-1)?.length ?? 0) === 0) output.pop();
	return output;
}

export function renderMarkdown(markdown: string, width: number): StyledLine[] {
	if (!markdown.trim()) return [];
	return renderTokens(Lexer.lex(markdown, { gfm: true }), Math.max(1, width)).map((line) =>
		lineWidth(line) > width ? padLine(line, width) : line,
	);
}

export function markdownPlainText(markdown: string): string {
	return renderMarkdown(markdown, Number.MAX_SAFE_INTEGER).map(plainText).join("\n");
}
