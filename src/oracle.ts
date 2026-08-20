import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { spawn } from "bun-pty";
import { diffArrays } from "diff";
import { cropOracleTranscript, frameFromXtermBuffer, frameRowText, frameText } from "./frame.ts";
import type { FrameCell, TerminalFrame } from "./types.ts";

const XtermTerminal = xterm.Terminal;

export interface OracleCaptureOptions {
	sessionPath: string;
	cwd: string;
	width?: number;
	height?: number;
	timeoutMs?: number;
	claudeBin?: string;
}

export interface IsolatedOracleSession {
	configDirectory: string;
	projectDirectory: string;
	sessionPath: string;
	sessionId: string;
	cleanup: () => void;
}

export interface OracleIsolationOptions {
	credentialSourceDirectory?: string;
	readMacKeychain?: boolean;
}

export function encodeClaudeProjectPath(cwd: string): string {
	return resolve(cwd).replace(/[^A-Za-z0-9]/gu, "-");
}

function sourceProjectName(sessionPath: string, cwd: string): string {
	const projectDirectory = dirname(sessionPath);
	return basename(dirname(projectDirectory)) === "projects" ? basename(projectDirectory) : encodeClaudeProjectPath(cwd);
}

function stageClaudeCredentials(configDirectory: string, options: OracleIsolationOptions): void {
	const sourceDirectory = resolve(
		options.credentialSourceDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
	);
	const sourcePath = join(sourceDirectory, ".credentials.json");
	const destinationPath = join(configDirectory, ".credentials.json");
	if (existsSync(sourcePath) && statSync(sourcePath).isFile()) {
		copyFileSync(sourcePath, destinationPath);
		chmodSync(destinationPath, 0o600);
		return;
	}

	if (process.platform !== "darwin" || options.readMacKeychain === false) return;
	const credential = Bun.spawnSync([
		"/usr/bin/security",
		"find-generic-password",
		"-s",
		"Claude Code-credentials",
		"-w",
	]);
	if (credential.exitCode !== 0 || credential.stdout.length === 0) return;
	writeFileSync(destinationPath, credential.stdout, { mode: 0o600 });
}

function stageOracleDefaults(configDirectory: string, cwd: string): void {
	// This is the persisted equivalent of choosing Claude's first "Auto (match terminal)" theme option.
	// Mark onboarding complete so an already-authenticated disposable config does not open the account picker.
	const state = {
		hasCompletedOnboarding: true,
		hasSeenAutoModeEntryWarning: true,
		projects: {
			[resolve(cwd)]: {
				hasCompletedProjectOnboarding: true,
				hasTrustDialogAccepted: true,
			},
		},
	};
	writeFileSync(join(configDirectory, ".claude.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
	writeFileSync(join(configDirectory, "settings.json"), '{"theme":"auto","tui":"fullscreen"}\n', { mode: 0o600 });
}

export function createIsolatedOracleSession(
	sessionPath: string,
	cwd: string,
	options: OracleIsolationOptions = {},
): IsolatedOracleSession {
	const sourcePath = resolve(sessionPath);
	if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
		throw new Error(`Oracle session file does not exist: ${sourcePath}`);
	}
	if (extname(sourcePath) !== ".jsonl") throw new Error(`Oracle session must be a JSONL file: ${sourcePath}`);

	const configDirectory = mkdtempSync(join(tmpdir(), "claude-viewer-oracle-"));
	try {
		stageClaudeCredentials(configDirectory, options);
		stageOracleDefaults(configDirectory, cwd);
		const sessionId = basename(sourcePath, ".jsonl");
		const projectDirectory = join(configDirectory, "projects", sourceProjectName(sourcePath, cwd));
		const copiedSessionPath = join(projectDirectory, `${sessionId}.jsonl`);
		mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
		copyFileSync(sourcePath, copiedSessionPath);
		chmodSync(copiedSessionPath, 0o600);
		return {
			configDirectory,
			projectDirectory,
			sessionPath: copiedSessionPath,
			sessionId,
			cleanup: () => rmSync(configDirectory, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(configDirectory, { recursive: true, force: true });
		throw error;
	}
}

function environment(configDirectory: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && name !== "NO_COLOR" && name !== "FORCE_COLOR" && name !== "CLAUDE_CONFIG_DIR") {
			result[name] = value;
		}
	}
	result.CLAUDE_CONFIG_DIR = configDirectory;
	result.TERM = "xterm-256color";
	result.COLORTERM = "truecolor";
	result.FORCE_COLOR = "3";
	result.CLICOLOR_FORCE = "1";
	result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	result.DISABLE_AUTOUPDATER = "1";
	return result;
}

function terminalText(terminal: XtermTerminalType): string {
	const buffer = terminal.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < buffer.length; row++) {
		lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
	}
	return lines.join("\n");
}

function composerReady(text: string): boolean {
	return (
		text.includes("❯") &&
		(text.includes("auto mode on") || text.includes("shift+tab to cycle") || text.includes("/effort"))
	);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupAlive(pid: number): boolean {
	if (pid <= 1) return false;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (pid <= 1) return;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The oracle already exited.
		}
	}
}

async function terminateOracleProcess(oracle: ReturnType<typeof spawn>): Promise<void> {
	const pid = oracle.pid;
	signalProcessGroup(pid, "SIGTERM");
	try {
		oracle.kill("SIGTERM");
	} catch {
		// bun-pty may already have closed its handle after an ordinary exit.
	}
	const deadline = Date.now() + 1000;
	while (processGroupAlive(pid) && Date.now() < deadline) await delay(25);
	if (!processGroupAlive(pid)) return;
	signalProcessGroup(pid, "SIGKILL");
	const killDeadline = Date.now() + 500;
	while (processGroupAlive(pid) && Date.now() < killDeadline) await delay(25);
}

async function flush(terminal: XtermTerminalType): Promise<void> {
	await new Promise<void>((resolve) => terminal.write("", resolve));
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	description: string,
	processExited: () => boolean,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (processExited()) throw new Error(`Claude Code exited before ${description}`);
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForQuiet(lastActivity: () => number, maximumWaitMs: number, quietMs = 350): Promise<void> {
	const deadline = Date.now() + maximumWaitMs;
	while (Date.now() < deadline) {
		if (Date.now() - lastActivity() >= quietMs) return;
		await delay(50);
	}
}

function versionFromFrame(frame: TerminalFrame): string | undefined {
	return /Claude Code\s+v?([\d.]+)/u.exec(frameText(frame))?.[1];
}

function normalizedViewportText(row: readonly FrameCell[]): string {
	return frameRowText(row).replace(
		/(✻\s+)(?:Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked)(\s+for\s+)/gu,
		"$1Worked$2",
	);
}

function captureArtifactRow(row: readonly FrameCell[]): boolean {
	return /^\d{2}:\d{2}\s+(?:AM|PM)\s+<synthetic>$/u.test(frameRowText(row).trim());
}

function remoteControlArtifactRow(row: readonly FrameCell[]): boolean {
	const text = frameRowText(row).trim();
	return (
		text.startsWith("⏺ Remote Control disconnected — Couldn't reconnect to your Remote Control session.") ||
		/^session without --resume\. — run \/remote-control to reconnect$/u.test(text)
	);
}

export function removeCaptureArtifacts(rows: readonly FrameCell[][]): FrameCell[][] {
	const output: FrameCell[][] = [];
	for (const row of rows) {
		if (captureArtifactRow(row)) {
			if ((output.at(-1)?.length ?? 0) === 0) output.pop();
			continue;
		}
		output.push(row);
	}
	while (output.length > 0 && remoteControlArtifactRow(output.at(-1) ?? [])) output.pop();
	if ((output.at(-1)?.length ?? 0) === 0) output.pop();
	return output;
}

function cropDetailedViewport(frame: TerminalFrame): TerminalFrame {
	const texts = frame.rows.map(frameRowText);
	const footer = texts.findIndex((text) => text.includes("Showing detailed transcript"));
	let end = footer >= 0 ? footer : texts.length;
	while (end > 0 && (!texts[end - 1]?.trim() || /^─+$/u.test(texts[end - 1]?.trim() ?? ""))) end--;
	let start = 0;
	const header = texts.findIndex((text) => text.includes("Claude Code"));
	if (header >= 0) {
		for (let index = header + 1; index < end; index++) {
			if (texts[index]?.trimStart().startsWith("❯")) {
				start = index;
				break;
			}
		}
	}
	while (start < end && !texts[start]?.trim()) start++;
	const rows = frame.rows.slice(start, end);
	return { schemaVersion: 1, width: frame.width, height: rows.length, rows, metadata: frame.metadata };
}

function maximumOverlap(existing: readonly FrameCell[][], incoming: readonly FrameCell[][]): number {
	const maximum = Math.min(existing.length, incoming.length);
	for (let size = maximum; size > 0; size--) {
		let matches = true;
		for (let index = 0; index < size; index++) {
			const left = existing[existing.length - size + index] ?? [];
			const right = incoming[index] ?? [];
			if (normalizedViewportText(left) !== normalizedViewportText(right)) {
				matches = false;
				break;
			}
		}
		if (matches) return size;
	}
	return 0;
}

export function reconcileDetailedRows(
	styledRows: readonly FrameCell[][],
	printedRows: readonly FrameCell[][],
): FrameCell[][] {
	const styledText = styledRows.map(normalizedViewportText);
	const printedText = printedRows.map(normalizedViewportText);
	const parts = diffArrays(printedText, styledText);
	const rows: FrameCell[][] = [];
	let styledIndex = 0;
	let printedIndex = 0;
	for (const part of parts) {
		if (!part.added && !part.removed) {
			for (const _value of part.value) {
				rows.push(styledRows[styledIndex] ?? printedRows[printedIndex] ?? []);
				styledIndex++;
				printedIndex++;
			}
		} else if (part.removed) {
			for (const _value of part.value) {
				rows.push(printedRows[printedIndex] ?? []);
				printedIndex++;
			}
		} else {
			styledIndex += part.value.length;
		}
	}
	return rows;
}

async function captureDetailedPages(
	oracle: ReturnType<typeof spawn>,
	terminal: XtermTerminalType,
	width: number,
	lastActivity: () => number,
	timeoutMs: number,
): Promise<{ rows: FrameCell[][]; pageCount: number }> {
	const rows: FrameCell[][] = [];
	let previousSignature = "";
	let pageCount = 0;
	for (let page = 0; page < 1000; page++) {
		await flush(terminal);
		const viewport = cropDetailedViewport(frameFromXtermBuffer(terminal.buffer.active, width));
		const signature = viewport.rows.map(normalizedViewportText).join("\n");
		if (page > 0 && signature === previousSignature) return { rows, pageCount };
		const overlap = maximumOverlap(rows, viewport.rows);
		rows.push(...viewport.rows.slice(overlap));
		pageCount++;
		previousSignature = signature;
		oracle.write(" ");
		await delay(100);
		await waitForQuiet(lastActivity, Math.min(timeoutMs, 2000));
	}
	throw new Error("Claude's detailed transcript exceeded the 1000-page capture limit");
}

export async function captureOracle(options: OracleCaptureOptions): Promise<TerminalFrame> {
	if (!existsSync(options.cwd)) throw new Error(`Oracle working directory does not exist: ${options.cwd}`);
	const isolated = createIsolatedOracleSession(options.sessionPath, options.cwd);
	try {
		return await captureIsolatedOracle(options, isolated);
	} finally {
		isolated.cleanup();
		await delay(250);
		isolated.cleanup();
	}
}

async function captureIsolatedOracle(
	options: OracleCaptureOptions,
	isolated: IsolatedOracleSession,
): Promise<TerminalFrame> {
	const width = Math.max(40, options.width ?? 120);
	const height = Math.max(12, options.height ?? 40);
	const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000);
	const terminal = new XtermTerminal({
		cols: width,
		rows: height,
		scrollback: 100_000,
		allowProposedApi: true,
	});
	let printTerminal: XtermTerminalType | undefined;
	let printBytes = 0;
	const oracle = spawn(
		options.claudeBin ?? process.env.CLAUDE_VIEWER_CLAUDE_BIN ?? "claude",
		["--safe-mode", "--resume", isolated.sessionId],
		{
			name: "xterm-256color",
			cols: width,
			rows: height,
			cwd: options.cwd,
			env: environment(isolated.configDirectory),
		},
	);
	let lastActivity = Date.now();
	let exited = false;
	const dataSubscription = oracle.onData((data) => {
		lastActivity = Date.now();
		terminal.write(data);
		if (printTerminal) {
			printBytes += Buffer.byteLength(data);
			printTerminal.write(data);
		}
	});
	const exitSubscription = oracle.onExit(() => {
		exited = true;
	});
	let selectedTerminalTheme = false;
	let version: string | undefined;

	try {
		await waitFor(
			() => {
				const text = terminalText(terminal);
				if (!selectedTerminalTheme && text.includes("Choose the text style that looks best with your terminal")) {
					selectedTerminalTheme = true;
					oracle.write(`${"\x1b[A".repeat(8)}\r`);
					return false;
				}
				if (text.includes("Select login method:")) {
					throw new Error("Claude Code authentication is unavailable inside the isolated oracle config");
				}
				if (/trust this (folder|project)|Yes, I trust/iu.test(text)) {
					throw new Error("Claude Code is waiting for a trust decision; open the session interactively first");
				}
				return composerReady(text);
			},
			timeoutMs,
			"the resumed session",
			() => exited,
		);
		await waitForQuiet(() => lastActivity, Math.min(timeoutMs, 3000));
		version = /Claude Code\s+v?([\d.]+)/u.exec(terminalText(terminal))?.[1];

		oracle.write("\x0f");
		await waitFor(
			() => terminalText(terminal).includes("Showing detailed transcript"),
			timeoutMs,
			"the detailed transcript",
			() => exited,
		);
		oracle.write("g");
		await waitForQuiet(() => lastActivity, Math.min(timeoutMs, 2000));
		const detailed = await captureDetailedPages(oracle, terminal, width, () => lastActivity, timeoutMs);

		printTerminal = new XtermTerminal({
			cols: width,
			rows: height,
			scrollback: 100_000,
			disableStdin: true,
			allowProposedApi: true,
		});
		printBytes = 0;
		oracle.write("[");
		await waitFor(
			() => printBytes > 0,
			timeoutMs,
			"Claude's transcript scrollback print",
			() => exited,
		);
		await waitForQuiet(() => lastActivity, Math.min(timeoutMs, 3000), 500);
		await flush(terminal);
		await flush(printTerminal);

		const full = frameFromXtermBuffer(printTerminal.buffer.normal, width, {
			source: "claude-code-oracle",
			capturedAt: new Date().toISOString(),
			terminalHeight: height,
		});
		const printed = cropOracleTranscript(full);
		if (!printed.rows.some((row) => frameRowText(row).trimStart().startsWith("❯"))) {
			throw new Error("Claude's scrollback print did not contain a transcript");
		}
		const reconciledRows = removeCaptureArtifacts(reconcileDetailedRows(detailed.rows, printed.rows));
		version ??= versionFromFrame(full);
		const metadata: TerminalFrame["metadata"] = {
			source: "claude-code-oracle",
			capturedAt: new Date().toISOString(),
			terminalHeight: height,
			captureMethod: "paged-detailed-overlay",
			pageCount: detailed.pageCount,
			pagedRows: detailed.rows.length,
			printedRows: printed.rows.length,
			cropped: true,
		};
		if (version) metadata.claudeVersion = version;
		return {
			schemaVersion: 1,
			width,
			height: reconciledRows.length,
			rows: reconciledRows,
			metadata,
		};
	} catch (error) {
		const debugPath = process.env.CLAUDE_VIEWER_ORACLE_DEBUG;
		if (debugPath) {
			await flush(terminal);
			writeOracleFrame(
				resolve(debugPath),
				frameFromXtermBuffer(terminal.buffer.active, width, {
					source: "claude-code-oracle-debug",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			if (printTerminal) {
				await flush(printTerminal);
				const printDebugPath = debugPath.endsWith(".json")
					? `${debugPath.slice(0, -5)}.print.json`
					: `${debugPath}.print.json`;
				writeOracleFrame(
					resolve(printDebugPath),
					frameFromXtermBuffer(printTerminal.buffer.normal, width, {
						source: "claude-code-oracle-print-debug",
						bytes: printBytes,
					}),
				);
			}
		}
		throw error;
	} finally {
		dataSubscription.dispose();
		await terminateOracleProcess(oracle);
		exitSubscription.dispose();
		printTerminal?.dispose();
		terminal.dispose();
	}
}

export function writeOracleFrame(path: string, frame: TerminalFrame): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(frame, null, 2)}\n`, { mode: 0o600 });
}
