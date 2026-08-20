import { buildTranscript } from "./model.ts";
import { nearestPrompt, renderTranscript, visibleDocument } from "./render.ts";
import { readSessionSnapshot, SessionFollower } from "./session.ts";
import { ansiDocument, ansiLine, appendSpan, plainText } from "./styled.ts";
import { CLAUDE_COLORS, CLAUDE_STYLES } from "./theme.ts";
import type { RenderMode, StyledLine, TextStyle, TranscriptDocument } from "./types.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const LEAVE_ALT_SCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l\x1b[0m";

export interface ViewerOptions {
	sessionPath: string;
	mode?: RenderMode;
	follow?: boolean;
}

function highlightLine(line: StyledLine, query: string): StyledLine {
	if (!query) return line;
	const source = plainText(line);
	const lower = source.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	const ranges: Array<[number, number]> = [];
	let cursor = 0;
	while (cursor <= source.length - needle.length) {
		const index = lower.indexOf(needle, cursor);
		if (index < 0) break;
		ranges.push([index, index + needle.length]);
		cursor = Math.max(index + needle.length, index + 1);
	}
	if (ranges.length === 0) return line;

	const output: StyledLine = [];
	let sourceOffset = 0;
	for (const span of line) {
		let spanOffset = 0;
		while (spanOffset < span.text.length) {
			const absolute = sourceOffset + spanOffset;
			const range = ranges.find(([start, end]) => absolute >= start && absolute < end);
			const nextBoundary = range
				? range[1]
				: Math.min(...ranges.filter(([start]) => start > absolute).map(([start]) => start), source.length);
			const take = Math.max(1, Math.min(span.text.length - spanOffset, nextBoundary - absolute));
			const text = span.text.slice(spanOffset, spanOffset + take);
			const style: TextStyle | undefined = range
				? { ...span.style, bg: CLAUDE_COLORS.link, fg: "#000000" }
				: span.style;
			appendSpan(output, text, style);
			spanOffset += take;
		}
		sourceOffset += span.text.length;
	}
	return output;
}

function printableInput(data: string): boolean {
	if (!data) return false;
	return [...data].every((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint !== 0x7f;
	});
}

function mouseScroll(data: string): -1 | 0 | 1 {
	const prefix = data.startsWith("\x1b[<64;") ? -1 : data.startsWith("\x1b[<65;") ? 1 : 0;
	return prefix !== 0 && /^\d+;\d+[mM]$/u.test(data.slice(6)) ? prefix : 0;
}

export interface DecodedInput {
	tokens: string[];
	remainder: string;
}

function firstCharacter(text: string): string {
	const codePoint = text.codePointAt(0);
	return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

export function decodeInputSequences(data: string, flushIncomplete = false): DecodedInput {
	const tokens: string[] = [];
	let cursor = 0;
	while (cursor < data.length) {
		if (data[cursor] !== "\x1b") {
			const character = firstCharacter(data.slice(cursor));
			tokens.push(character);
			cursor += character.length;
			continue;
		}

		if (cursor + 1 >= data.length) {
			if (flushIncomplete) {
				tokens.push("\x1b");
				cursor++;
			}
			break;
		}

		const introducer = data[cursor + 1];
		if (introducer === "[") {
			let end = cursor + 2;
			while (end < data.length) {
				const code = data.charCodeAt(end);
				if (code >= 0x40 && code <= 0x7e) break;
				end++;
			}
			if (end >= data.length) {
				if (flushIncomplete) {
					tokens.push(data.slice(cursor));
					cursor = data.length;
				}
				break;
			}
			tokens.push(data.slice(cursor, end + 1));
			cursor = end + 1;
			continue;
		}

		if (introducer === "O") {
			if (cursor + 2 >= data.length) {
				if (flushIncomplete) {
					tokens.push(data.slice(cursor));
					cursor = data.length;
				}
				break;
			}
			tokens.push(data.slice(cursor, cursor + 3));
			cursor += 3;
			continue;
		}

		const modified = firstCharacter(data.slice(cursor + 1));
		tokens.push(`\x1b${modified}`);
		cursor += 1 + modified.length;
	}
	return { tokens, remainder: data.slice(cursor) };
}

class TranscriptViewer {
	readonly #sessionPath: string;
	readonly #onExit: () => void;
	#mode: RenderMode;
	#document: TranscriptDocument = { lines: [], promptRows: [] };
	#offset = 0;
	#followTail = true;
	#searchEditing = false;
	#searchQuery = "";
	#inputBuffer = "";
	#inputFlushTimer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;

	constructor(options: ViewerOptions, onExit: () => void) {
		this.#sessionPath = options.sessionPath;
		this.#mode = options.mode ?? "compact";
		this.#onExit = onExit;
	}

	get #width(): number {
		return Math.max(12, process.stdout.columns ?? 80);
	}

	get #height(): number {
		const terminalHeight = Math.max(1, process.stdout.rows ?? 24);
		return Math.max(1, terminalHeight - (this.#searchEditing ? 1 : 0));
	}

	get #maximumOffset(): number {
		return Math.max(0, this.#document.lines.length - this.#height);
	}

	start(): void {
		process.stdout.write(ENTER_ALT_SCREEN);
		this.reload();
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#inputFlushTimer) clearTimeout(this.#inputFlushTimer);
		process.stdout.write(LEAVE_ALT_SCREEN);
	}

	reload(): void {
		const transcript = buildTranscript(readSessionSnapshot(this.#sessionPath).records);
		const oldMaximum = this.#maximumOffset;
		const oldOffset = this.#offset;
		this.#document = renderTranscript(transcript, { width: this.#width, mode: this.#mode });
		if (this.#followTail) this.#offset = this.#maximumOffset;
		else if (oldMaximum > 0)
			this.#offset = Math.min(this.#maximumOffset, Math.round((oldOffset / oldMaximum) * this.#maximumOffset));
		else this.#offset = Math.min(oldOffset, this.#maximumOffset);
		this.render();
	}

	render(): void {
		if (this.#stopped) return;
		const viewport = visibleDocument(this.#document, this.#offset, this.#height, this.#width).map((line) =>
			this.#searchQuery ? highlightLine(line, this.#searchQuery) : line,
		);
		let output = "\x1b[H";
		for (const [index, line] of viewport.entries()) {
			output += `${ansiLine(line)}\x1b[K`;
			if (index + 1 < viewport.length || this.#searchEditing) output += "\r\n";
		}
		if (this.#searchEditing) {
			const search = [{ text: `/${this.#searchQuery}`, style: CLAUDE_STYLES.muted }];
			output += `${ansiLine(search)}\x1b[K`;
		}
		process.stdout.write(output);
	}

	resize(): void {
		this.reload();
	}

	#scroll(delta: number): void {
		this.#offset = Math.max(0, Math.min(this.#maximumOffset, this.#offset + delta));
		this.#followTail = this.#offset >= this.#maximumOffset;
		this.render();
	}

	#jump(offset: number): void {
		this.#offset = Math.max(0, Math.min(this.#maximumOffset, offset));
		this.#followTail = this.#offset >= this.#maximumOffset;
		this.render();
	}

	#toggleMode(): void {
		const oldMaximum = this.#maximumOffset;
		const oldOffset = this.#offset;
		const wasFollowing = this.#followTail;
		this.#mode = this.#mode === "compact" ? "detailed" : "compact";
		const transcript = buildTranscript(readSessionSnapshot(this.#sessionPath).records);
		this.#document = renderTranscript(transcript, { width: this.#width, mode: this.#mode });
		this.#offset = wasFollowing
			? this.#maximumOffset
			: oldMaximum > 0
				? Math.round((oldOffset / oldMaximum) * this.#maximumOffset)
				: 0;
		this.#followTail = wasFollowing;
		this.render();
	}

	#find(direction: -1 | 1): void {
		if (!this.#searchQuery) return;
		const matchingRows = this.#document.lines.flatMap((line, row) =>
			plainText(line).toLocaleLowerCase().includes(this.#searchQuery.toLocaleLowerCase()) ? [row] : [],
		);
		if (matchingRows.length === 0) return;
		const current = this.#offset;
		const match =
			direction > 0
				? (matchingRows.find((row) => row > current) ?? matchingRows[0])
				: (matchingRows.findLast((row) => row < current) ?? matchingRows.at(-1));
		if (match !== undefined) this.#jump(match);
	}

	#printToScrollback(): void {
		process.stdout.write(`${LEAVE_ALT_SCREEN}${ansiDocument(this.#document.lines)}\x1b[0m\n${ENTER_ALT_SCREEN}`);
		this.render();
	}

	#exit(): void {
		this.#onExit();
	}

	#handleSearchInput(data: string): boolean {
		if (!this.#searchEditing) return false;
		if (data === "\r" || data === "\n") {
			this.#searchEditing = false;
			this.#find(1);
			this.render();
			return true;
		}
		if (data === "\x1b") {
			this.#searchEditing = false;
			this.render();
			return true;
		}
		if (data === "\x7f" || data === "\b") {
			this.#searchQuery = this.#searchQuery.slice(0, -1);
			this.render();
			return true;
		}
		if (printableInput(data)) {
			this.#searchQuery += data;
			this.render();
			return true;
		}
		return true;
	}

	#handleInputToken(data: string): void {
		if (this.#handleSearchInput(data)) return;
		const mouseDirection = mouseScroll(data);
		if (mouseDirection !== 0) {
			this.#scroll(mouseDirection * 3);
			return;
		}
		switch (data) {
			case "\x1b[A":
			case "\x1bOA":
				this.#scroll(-1);
				return;
			case "\x1b[B":
			case "\x1bOB":
				this.#scroll(1);
				return;
			case "\x1b[5~":
				this.#scroll(-this.#height);
				return;
			case "\x1b[6~":
				this.#scroll(this.#height);
				return;
			case "\x1b[H":
			case "\x1bOH":
			case "\x1b[1~":
			case "\x1b[7~":
				this.#jump(0);
				return;
			case "\x1b[F":
			case "\x1bOF":
			case "\x1b[4~":
			case "\x1b[8~":
				this.#jump(this.#maximumOffset);
				return;
		}

		switch (data) {
			case "q":
			case "\x03":
			case "\x1b":
				this.#exit();
				return;
			case "k":
				this.#scroll(-1);
				return;
			case "j":
				this.#scroll(1);
				return;
			case "\x15":
				this.#scroll(-Math.max(1, Math.floor(this.#height / 2)));
				return;
			case "\x04":
				this.#scroll(Math.max(1, Math.floor(this.#height / 2)));
				return;
			case "b":
				this.#scroll(-this.#height);
				return;
			case " ":
				this.#scroll(this.#height);
				return;
			case "g":
				this.#jump(0);
				return;
			case "G":
				this.#jump(this.#maximumOffset);
				return;
			case "\x0f":
				this.#toggleMode();
				return;
			case "/":
				this.#searchEditing = true;
				this.#searchQuery = "";
				this.render();
				return;
			case "n":
				this.#find(1);
				return;
			case "N":
				this.#find(-1);
				return;
			case "{": {
				const row = nearestPrompt(this.#document, this.#offset, -1);
				if (row !== undefined) this.#jump(row);
				return;
			}
			case "}": {
				const row = nearestPrompt(this.#document, this.#offset, 1);
				if (row !== undefined) this.#jump(row);
				return;
			}
			case "[":
				this.#printToScrollback();
				return;
		}
	}

	#drainInput(flushIncomplete: boolean): void {
		const decoded = decodeInputSequences(this.#inputBuffer, flushIncomplete);
		this.#inputBuffer = decoded.remainder;
		for (const token of decoded.tokens) this.#handleInputToken(token);
	}

	handleInput(data: string): void {
		if (this.#inputFlushTimer) {
			clearTimeout(this.#inputFlushTimer);
			this.#inputFlushTimer = undefined;
		}
		this.#inputBuffer += data;
		this.#drainInput(false);
		if (!this.#inputBuffer) return;
		this.#inputFlushTimer = setTimeout(() => {
			this.#inputFlushTimer = undefined;
			this.#drainInput(true);
		}, 25);
	}
}

export async function runViewer(options: ViewerOptions): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("claude-viewer requires an interactive terminal (use --print for non-interactive output)");
	}
	let resolveExit: () => void = () => {};
	const exitRequested = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	const viewer = new TranscriptViewer(options, resolveExit);
	const follower = options.follow === false ? undefined : new SessionFollower(options.sessionPath);
	const input = (data: Buffer | string): void => viewer.handleInput(data.toString());
	const resize = (): void => viewer.resize();
	const signal = (): void => resolveExit();

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", input);
	process.stdout.on("resize", resize);
	process.on("SIGINT", signal);
	process.on("SIGTERM", signal);
	process.on("SIGHUP", signal);
	try {
		viewer.start();
		follower?.start(() => viewer.reload());
		await exitRequested;
	} finally {
		follower?.stop();
		process.stdin.off("data", input);
		process.stdout.off("resize", resize);
		process.off("SIGINT", signal);
		process.off("SIGTERM", signal);
		process.off("SIGHUP", signal);
		process.stdin.setRawMode(false);
		process.stdin.pause();
		viewer.stop();
	}
}
