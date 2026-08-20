#!/usr/bin/env bun

import { basename, resolve } from "node:path";
import { compareFrames, comparisonText, cropOracleTranscript, frameFromStyledLines, readFrame } from "./frame.ts";
import { buildTranscript } from "./model.ts";
import { captureOracle, removeCaptureArtifacts, writeOracleFrame } from "./oracle.ts";
import { renderTranscript } from "./render.ts";
import { defaultProjectsDirectory, readSessionSnapshot, resolveSessionFile } from "./session.ts";
import { ansiDocument, plainText } from "./styled.ts";
import type { RenderMode } from "./types.ts";
import { runViewer } from "./viewer.ts";

const VERSION = "0.1.0";

const HELP = `claude-viewer — live, read-only Claude Code transcript viewer

Usage:
  claude-viewer <session-id|path> [options]
  claude-viewer --session <session-id|path> [options]
  claude-viewer oracle capture <session-id|path> [options]
  claude-viewer oracle compare <session-id|path> <frame.json> [--json]

Viewer options:
  --session-dir <dir>    Claude projects directory to search
  --mode <mode>          compact (default) or detailed
  --detailed             Start with expanded tool output
  --no-follow            Do not watch for appended session records
  --print                Print once instead of opening the TUI
  --color <when>         auto, always, or never (with --print)
  --width <columns>      Render width for --print (default: terminal or 120)
  --help, -h             Show help
  --version, -v          Show version

Oracle capture options:
  --out <frame.json>     Local output under .oracle/ by default
  --cwd <dir>            Working directory for the official Claude client
  --width <columns>      PTY width (default: 120)
  --height <rows>        PTY height (default: 40)
  --timeout <ms>         Per-stage timeout (default: 30000)

Keys: ↑↓ or j/k scroll, ctrl+u/d half page, space/b page, g/G top/bottom,
{/} previous/next prompt, / search, n/N matches, ctrl+o compact/detailed,
[ print to scrollback, q/Escape/ctrl+c exit.`;

interface ViewerCliOptions {
	session: string | undefined;
	sessionDirectory: string;
	mode: RenderMode;
	follow: boolean;
	print: boolean;
	color: "auto" | "always" | "never";
	width: number | undefined;
	help: boolean;
	version: boolean;
}

function optionValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
	return value;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer`);
	return parsed;
}

function parseViewerArgs(args: string[]): ViewerCliOptions {
	const options: ViewerCliOptions = {
		session: undefined,
		sessionDirectory: defaultProjectsDirectory(),
		mode: "compact",
		follow: true,
		print: false,
		color: "auto",
		width: undefined,
		help: false,
		version: false,
	};
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index] as string;
		switch (argument) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--version":
			case "-v":
				options.version = true;
				break;
			case "--session":
				options.session = optionValue(args, index, argument);
				index++;
				break;
			case "--session-dir":
				options.sessionDirectory = resolve(optionValue(args, index, argument));
				index++;
				break;
			case "--mode": {
				const value = optionValue(args, index, argument);
				if (value !== "compact" && value !== "detailed") throw new Error("--mode must be compact or detailed");
				options.mode = value;
				index++;
				break;
			}
			case "--detailed":
				options.mode = "detailed";
				break;
			case "--no-follow":
				options.follow = false;
				break;
			case "--print":
				options.print = true;
				break;
			case "--color": {
				const value = optionValue(args, index, argument);
				if (value !== "auto" && value !== "always" && value !== "never") {
					throw new Error("--color must be auto, always, or never");
				}
				options.color = value;
				index++;
				break;
			}
			case "--width":
				options.width = positiveInteger(optionValue(args, index, argument), argument);
				index++;
				break;
			default:
				if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
				positional.push(argument);
		}
	}
	if (options.session && positional.length > 0)
		throw new Error("Provide the session positionally or with --session, not both");
	if (!options.session && positional.length === 1) options.session = positional[0];
	if (positional.length > 1) throw new Error("Only one session may be provided");
	return options;
}

interface OracleOptions {
	action: "capture" | "compare";
	session: string;
	framePath: string | undefined;
	outputPath: string | undefined;
	cwd: string | undefined;
	width: number;
	height: number;
	timeoutMs: number;
	json: boolean;
	sessionDirectory: string;
}

function parseOracleArgs(args: string[]): OracleOptions {
	const action = args[0];
	if (action !== "capture" && action !== "compare") throw new Error("Oracle action must be capture or compare");
	const positional: string[] = [];
	let outputPath: string | undefined;
	let cwd: string | undefined;
	let width = 120;
	let height = 40;
	let timeoutMs = 30_000;
	let json = false;
	let sessionDirectory = defaultProjectsDirectory();
	for (let index = 1; index < args.length; index++) {
		const argument = args[index] as string;
		switch (argument) {
			case "--out":
				outputPath = resolve(optionValue(args, index, argument));
				index++;
				break;
			case "--cwd":
				cwd = resolve(optionValue(args, index, argument));
				index++;
				break;
			case "--width":
				width = positiveInteger(optionValue(args, index, argument), argument);
				index++;
				break;
			case "--height":
				height = positiveInteger(optionValue(args, index, argument), argument);
				index++;
				break;
			case "--timeout":
				timeoutMs = positiveInteger(optionValue(args, index, argument), argument);
				index++;
				break;
			case "--session-dir":
				sessionDirectory = resolve(optionValue(args, index, argument));
				index++;
				break;
			case "--json":
				json = true;
				break;
			default:
				if (argument.startsWith("-")) throw new Error(`Unknown oracle option: ${argument}`);
				positional.push(argument);
		}
	}
	if (!positional[0]) throw new Error("An oracle session is required");
	if (action === "capture" && positional.length > 1) throw new Error("Oracle capture accepts one session");
	if (action === "compare" && positional.length !== 2)
		throw new Error("Oracle compare requires a session and frame.json");
	return {
		action,
		session: positional[0],
		framePath: positional[1] ? resolve(positional[1]) : undefined,
		outputPath,
		cwd,
		width,
		height,
		timeoutMs,
		json,
		sessionDirectory,
	};
}

async function runOracle(args: string[]): Promise<void> {
	const options = parseOracleArgs(args);
	const sessionPath = await resolveSessionFile(options.session, options.sessionDirectory);
	const transcript = buildTranscript(readSessionSnapshot(sessionPath).records);
	if (options.action === "capture") {
		const sessionId = transcript.sessionId ?? basename(sessionPath, ".jsonl");
		const outputPath = options.outputPath ?? resolve(`.oracle/${sessionId}-${options.width}x${options.height}.json`);
		const frame = await captureOracle({
			sessionPath,
			cwd: options.cwd ?? transcript.cwd ?? process.cwd(),
			width: options.width,
			height: options.height,
			timeoutMs: options.timeoutMs,
		});
		writeOracleFrame(outputPath, frame);
		process.stdout.write(`${outputPath}\n`);
		return;
	}

	if (!options.framePath) throw new Error("Oracle compare requires a frame path");
	const cropped = cropOracleTranscript(readFrame(options.framePath));
	const expectedRows = removeCaptureArtifacts(cropped.rows);
	const expected = { ...cropped, height: expectedRows.length, rows: expectedRows };
	const document = renderTranscript(transcript, { width: expected.width, mode: "detailed" });
	const actual = frameFromStyledLines(document.lines, expected.width, {
		source: "claude-viewer",
		mode: "detailed",
	});
	const comparison = compareFrames(expected, actual);
	process.stdout.write(options.json ? `${JSON.stringify(comparison, null, 2)}\n` : `${comparisonText(comparison)}\n`);
	if (!comparison.match) process.exitCode = 1;
}

async function main(args: string[]): Promise<void> {
	if (args[0] === "oracle") {
		await runOracle(args.slice(1));
		return;
	}
	const options = parseViewerArgs(args);
	if (options.help) {
		process.stdout.write(`${HELP}\n`);
		return;
	}
	if (options.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (!options.session) throw new Error(`A session ID or path is required\n\n${HELP}`);
	const sessionPath = await resolveSessionFile(options.session, options.sessionDirectory);
	if (options.print) {
		const transcript = buildTranscript(readSessionSnapshot(sessionPath).records);
		const width = options.width ?? process.stdout.columns ?? 120;
		const document = renderTranscript(transcript, { width, mode: options.mode });
		const color = options.color === "always" || (options.color === "auto" && process.stdout.isTTY);
		const output = color
			? ansiDocument(document.lines)
			: document.lines.map((line) => plainText(line).trimEnd()).join("\n");
		process.stdout.write(`${output}\n`);
		return;
	}
	await runViewer({ sessionPath, mode: options.mode, follow: options.follow });
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`claude-viewer: ${message}\n`);
	process.exitCode = 1;
});
