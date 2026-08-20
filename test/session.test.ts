import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscript } from "../src/model.ts";
import { parseSessionText, readSessionSnapshot, SessionFollower, selectActiveBranch } from "../src/session.ts";

const fixturePath = join(import.meta.dir, "fixtures", "representative.jsonl");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session input", () => {
	test("ignores malformed and non-object JSONL records", () => {
		expect(parseSessionText('{"type":"user"}\n[1,2]\nnull\n{"partial"')).toEqual([{ type: "user" }]);
	});

	test("selects the branch named by the latest leaf record", () => {
		const records = [
			{ uuid: "root", parentUuid: null, type: "user" },
			{ uuid: "old", parentUuid: "root", type: "assistant" },
			{ uuid: "new", parentUuid: "root", type: "assistant" },
			{ type: "last-prompt", leafUuid: "new" },
		];
		expect(selectActiveBranch(records).map((record) => record.uuid)).toEqual(["root", "new"]);
	});

	test("builds a transcript and safely ignores a future record", () => {
		const transcript = buildTranscript(readSessionSnapshot(fixturePath).records);
		expect(transcript).toMatchObject({
			sessionId: "synthetic-session",
			cwd: "/workspace/project",
			version: "2.1.235",
		});
		expect(transcript.events.map((event) => event.kind)).toEqual([
			"user",
			"assistant",
			"duration",
			"user",
			"assistant",
			"duration",
		]);
		const firstAssistant = transcript.events.find((event) => event.kind === "assistant");
		expect(firstAssistant?.blocks.map((block) => block.kind === "tool" && block.name)).toEqual([
			false,
			"Read",
			"Bash",
			"Bash",
			"Skill",
			"Edit",
		]);
		if (firstAssistant?.kind !== "assistant") throw new Error("missing assistant event");
		const edit = firstAssistant.blocks.find((block) => block.kind === "tool" && block.name === "Edit");
		expect(edit?.kind === "tool" && edit.result?.details?.structuredPatch).toBeArray();
	});

	test("rejoins parallel sibling tool results by tool_use_id", () => {
		const transcript = buildTranscript([
			{ type: "user", uuid: "root", parentUuid: null, message: { role: "user", content: "run both" } },
			{
				type: "assistant",
				uuid: "calls",
				parentUuid: "root",
				message: {
					id: "parallel",
					role: "assistant",
					content: [
						{ type: "tool_use", id: "one", name: "Bash", input: { command: "one" } },
						{ type: "tool_use", id: "two", name: "Bash", input: { command: "two" } },
					],
				},
			},
			{
				type: "user",
				uuid: "result-one",
				parentUuid: "calls",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "first" }] },
			},
			{
				type: "user",
				uuid: "result-two",
				parentUuid: "calls",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "two", content: "second" }] },
			},
			{ type: "last-prompt", leafUuid: "result-two" },
		]);
		const assistant = transcript.events.find((event) => event.kind === "assistant");
		if (assistant?.kind !== "assistant") throw new Error("missing assistant event");
		expect(assistant.blocks.filter((block) => block.kind === "tool").map((block) => block.result?.content)).toEqual([
			"first",
			"second",
		]);
	});

	test("renders queued prompts on the active branch and keeps the latest assistant timestamp", () => {
		const transcript = buildTranscript([
			{ type: "user", uuid: "root", parentUuid: null, message: { role: "user", content: "first" } },
			{
				type: "assistant",
				uuid: "thinking",
				parentUuid: "root",
				timestamp: "2026-08-19T20:13:00.000Z",
				message: { id: "message", role: "assistant", model: "claude-test", content: [] },
			},
			{
				type: "assistant",
				uuid: "answer",
				parentUuid: "thinking",
				timestamp: "2026-08-19T20:14:00.000Z",
				message: { id: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "done" }] },
			},
			{
				type: "attachment",
				uuid: "queued",
				parentUuid: "answer",
				attachment: { type: "queued_command", prompt: "queued while working" },
			},
			{ type: "last-prompt", leafUuid: "queued" },
		]);
		expect(transcript.events.map((event) => event.kind)).toEqual(["user", "assistant", "user"]);
		expect(transcript.events[1]).toMatchObject({ kind: "assistant", timestamp: "2026-08-19T20:14:00.000Z" });
		expect(transcript.events[2]).toMatchObject({ kind: "user", text: "queued while working" });
	});

	test("follows complete records appended to a live file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-viewer-follow-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "session.jsonl");
		writeFileSync(path, '{"type":"user","uuid":"one"}\n');
		const follower = new SessionFollower(path);
		const lengths: number[] = [];
		const updated = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("follower did not publish")), 2000);
			follower.start((snapshot) => {
				lengths.push(snapshot.records.length);
				if (snapshot.records.length === 2) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		appendFileSync(path, '{"type":"assistant","uuid":"two"}\n{"partial"');
		await updated;
		follower.stop();
		expect(lengths).toEqual([1, 2]);
		expect(readFileSync(path, "utf8")).toContain('{"partial"');
	});
});
