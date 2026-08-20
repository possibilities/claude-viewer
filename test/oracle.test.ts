import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { frameFromStyledLines, frameText } from "../src/frame.ts";
import {
	createIsolatedOracleSession,
	encodeClaudeProjectPath,
	reconcileDetailedRows,
	removeCaptureArtifacts,
} from "../src/oracle.ts";
import { styled } from "../src/styled.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude Code oracle", () => {
	test("copies a source session into an isolated Claude config and removes only the copy", () => {
		const sourceDirectory = mkdtempSync(join(tmpdir(), "claude-viewer-source-"));
		temporaryDirectories.push(sourceDirectory);
		const sourcePath = join(sourceDirectory, "synthetic-session.jsonl");
		const source = '{"type":"user","message":{"content":"synthetic"}}\n';
		writeFileSync(sourcePath, source, { mode: 0o600 });

		const isolated = createIsolatedOracleSession(sourcePath, "/workspace/demo.project", {
			credentialSourceDirectory: sourceDirectory,
			readMacKeychain: false,
		});
		temporaryDirectories.push(isolated.configDirectory);
		expect(basename(isolated.projectDirectory)).toBe("-workspace-demo-project");
		expect(isolated.sessionId).toBe("synthetic-session");
		expect(readFileSync(isolated.sessionPath, "utf8")).toBe(source);
		expect(isolated.sessionPath).not.toBe(sourcePath);

		writeFileSync(isolated.sessionPath, `${source}{"type":"system"}\n`);
		isolated.cleanup();
		expect(existsSync(isolated.configDirectory)).toBeFalse();
		expect(readFileSync(sourcePath, "utf8")).toBe(source);
	});

	test("preserves Claude's existing encoded project directory when the source is under projects", () => {
		const configDirectory = mkdtempSync(join(tmpdir(), "claude-viewer-config-"));
		temporaryDirectories.push(configDirectory);
		const sourceDirectory = join(configDirectory, "projects", "-already-encoded");
		const sourcePath = join(sourceDirectory, "synthetic-session.jsonl");
		mkdirSync(sourceDirectory, { recursive: true });
		writeFileSync(sourcePath, "{}\n");

		const isolated = createIsolatedOracleSession(sourcePath, "/a/different/project", {
			credentialSourceDirectory: configDirectory,
			readMacKeychain: false,
		});
		temporaryDirectories.push(isolated.configDirectory);
		expect(basename(isolated.projectDirectory)).toBe("-already-encoded");
		isolated.cleanup();
	});

	test("encodes paths using Claude's project-directory convention", () => {
		expect(encodeClaudeProjectPath("/workspace/demo.project")).toBe("-workspace-demo-project");
	});

	test("copies file-based Claude credentials into the isolated config", () => {
		const sourceDirectory = mkdtempSync(join(tmpdir(), "claude-viewer-credentials-"));
		temporaryDirectories.push(sourceDirectory);
		const sourcePath = join(sourceDirectory, "synthetic-session.jsonl");
		writeFileSync(sourcePath, "{}\n");
		writeFileSync(join(sourceDirectory, ".credentials.json"), '{"synthetic":true}\n', { mode: 0o600 });

		const isolated = createIsolatedOracleSession(sourcePath, "/workspace/project", {
			credentialSourceDirectory: sourceDirectory,
			readMacKeychain: false,
		});
		temporaryDirectories.push(isolated.configDirectory);
		expect(readFileSync(join(isolated.configDirectory, ".credentials.json"), "utf8")).toBe('{"synthetic":true}\n');
		expect(JSON.parse(readFileSync(join(isolated.configDirectory, ".claude.json"), "utf8"))).toEqual({
			hasCompletedOnboarding: true,
			hasSeenAutoModeEntryWarning: true,
			projects: {
				"/workspace/project": {
					hasCompletedProjectOnboarding: true,
					hasTrustDialogAccepted: true,
				},
			},
		});
		expect(readFileSync(join(isolated.configDirectory, "settings.json"), "utf8")).toBe(
			'{"theme":"auto","tui":"fullscreen"}\n',
		);
		isolated.cleanup();
	});

	test("reconciles printed row structure with detailed overlay styles and drops synthetic timestamps", () => {
		const styledFrame = frameFromStyledLines(
			[styled("❯ prompt"), styled("⏺ answer", { fg: "#abcdef" }), styled("08:00 PM <synthetic>")],
			40,
		);
		const printedFrame = frameFromStyledLines(
			[styled("❯ prompt"), styled("⏺ answer"), styled("wrapped only in print"), [], styled("08:00 PM <synthetic>")],
			40,
		);
		const rows = removeCaptureArtifacts(reconcileDetailedRows(styledFrame.rows, printedFrame.rows));
		expect(frameText({ ...styledFrame, rows, height: rows.length })).toBe("❯ prompt\n⏺ answer\nwrapped only in print");
		expect(rows[1]?.[0]?.fg).toBe("#abcdef");
	});

	test("drops the Remote Control resume artifact from the end of a capture", () => {
		const rows = removeCaptureArtifacts(
			frameFromStyledLines(
				[
					styled("⏺ answer"),
					[],
					styled(
						"⏺ Remote Control disconnected — Couldn't reconnect to your Remote Control session. Retry, or start a fresh",
					),
					styled("  session without --resume. — run /remote-control to reconnect"),
				],
				120,
			).rows,
		);
		expect(frameText({ schemaVersion: 1, width: 120, height: rows.length, rows, metadata: {} })).toBe("⏺ answer");
	});
});
