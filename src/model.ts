import { selectActiveBranch } from "./session.ts";
import type {
	AssistantBlock,
	AssistantEvent,
	JsonObject,
	RawSessionRecord,
	ToolResult,
	Transcript,
	TranscriptEvent,
} from "./types.ts";

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) => {
			if (typeof item === "string") return [item];
			if (!isObject(item)) return [];
			const text = stringValue(item.text);
			return text ? [text] : [];
		})
		.join("\n");
}

function cleanUserText(text: string): string {
	const withoutReminders = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	const commandName = /<command-name>([\s\S]*?)<\/command-name>/u.exec(withoutReminders)?.[1]?.trim();
	if (commandName) {
		const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/u.exec(withoutReminders)?.[1]?.trim();
		return commandArgs ? `${commandName} ${commandArgs}` : commandName;
	}
	if (
		withoutReminders.startsWith("<local-command-caveat>") ||
		withoutReminders.startsWith("<command-message>") ||
		withoutReminders.startsWith("<command-name>") ||
		withoutReminders.startsWith("<local-command-stdout>")
	) {
		return "";
	}
	return withoutReminders;
}

function collectToolResults(records: readonly RawSessionRecord[]): Map<string, ToolResult> {
	const results = new Map<string, ToolResult>();
	for (const record of records) {
		const message = isObject(record.message) ? record.message : undefined;
		if (!message || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isObject(block) || block.type !== "tool_result") continue;
			const toolUseId = stringValue(block.tool_use_id);
			if (!toolUseId) continue;
			const content = contentText(block.content);
			results.set(toolUseId, {
				toolUseId,
				content,
				isError: block.is_error === true || /^Exit code \d+(?:\n|$)/u.test(content),
				details: isObject(record.toolUseResult) ? record.toolUseResult : undefined,
			});
		}
	}
	return results;
}

function recordId(record: RawSessionRecord, fallback: string): string {
	return stringValue(record.uuid) ?? fallback;
}

function recordTimestamp(record: RawSessionRecord): string | undefined {
	return stringValue(record.timestamp);
}

function latestString(records: readonly RawSessionRecord[], ...fields: string[]): string | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (!record) continue;
		for (const field of fields) {
			const value = stringValue(record[field]);
			if (value) return value;
		}
	}
	return undefined;
}

export function buildTranscript(allRecords: readonly RawSessionRecord[]): Transcript {
	const records = selectActiveBranch(allRecords).filter((record) => record.isSidechain !== true);
	// Parallel tool results are siblings in Claude's parent graph, not necessarily ancestors of the selected leaf.
	// Rejoin them by tool_use_id across the session; only calls on the visible branch can consume them below.
	const toolResults = collectToolResults(allRecords.filter((record) => record.isSidechain !== true));
	const events: TranscriptEvent[] = [];
	const assistantEvents = new Map<string, AssistantEvent>();
	const seenText = new Map<string, Set<string>>();
	const seenTools = new Set<string>();

	for (const [index, record] of records.entries()) {
		const type = stringValue(record.type);
		const message = isObject(record.message) ? record.message : undefined;

		if (type === "user" && message) {
			if (record.isMeta === true) continue;
			const role = stringValue(message.role);
			if (role && role !== "user") continue;
			const text = cleanUserText(contentText(message.content));
			if (!text) continue;
			events.push({
				kind: "user",
				id: recordId(record, `user-${index}`),
				text,
				timestamp: recordTimestamp(record),
			});
			continue;
		}

		if (type === "assistant" && message) {
			const messageId = stringValue(message.id) ?? recordId(record, `assistant-${index}`);
			let event = assistantEvents.get(messageId);
			if (!event) {
				event = {
					kind: "assistant",
					id: messageId,
					model: stringValue(message.model),
					timestamp: recordTimestamp(record),
					blocks: [],
				};
				assistantEvents.set(messageId, event);
				events.push(event);
			}
			event.model = stringValue(message.model) ?? event.model;
			event.timestamp = recordTimestamp(record) ?? event.timestamp;

			const rawBlocks = Array.isArray(message.content) ? message.content : [message.content];
			for (const rawBlock of rawBlocks) {
				if (typeof rawBlock === "string") {
					if (rawBlock) event.blocks.push({ kind: "text", text: rawBlock });
					continue;
				}
				if (!isObject(rawBlock)) continue;
				if (rawBlock.type === "text") {
					const text = stringValue(rawBlock.text);
					if (!text) continue;
					let values = seenText.get(messageId);
					if (!values) {
						values = new Set<string>();
						seenText.set(messageId, values);
					}
					if (!values.has(text)) {
						values.add(text);
						event.blocks.push({ kind: "text", text });
					}
					continue;
				}
				if (rawBlock.type !== "tool_use") continue;
				const id = stringValue(rawBlock.id);
				const name = stringValue(rawBlock.name);
				if (!id || !name || seenTools.has(id)) continue;
				seenTools.add(id);
				const block: AssistantBlock = {
					kind: "tool",
					id,
					name,
					input: isObject(rawBlock.input) ? rawBlock.input : {},
					result: toolResults.get(id),
				};
				event.blocks.push(block);
			}
			continue;
		}

		if (type === "attachment") {
			const attachment = isObject(record.attachment) ? record.attachment : undefined;
			const text = attachment?.type === "queued_command" ? stringValue(attachment.prompt)?.trim() : undefined;
			if (text) {
				events.push({
					kind: "user",
					id: recordId(record, `queued-user-${index}`),
					text,
					timestamp: recordTimestamp(record),
				});
			}
			continue;
		}

		if (type === "system" && record.subtype === "turn_duration") {
			const durationMs = numberValue(record.durationMs);
			if (durationMs !== undefined) {
				events.push({
					kind: "duration",
					id: recordId(record, `duration-${index}`),
					durationMs,
					timestamp: recordTimestamp(record),
				});
			}
			continue;
		}

		if (type === "system" && typeof record.content === "string" && record.subtype !== "thinking") {
			events.push({
				kind: "notice",
				id: recordId(record, `notice-${index}`),
				text: record.content,
				level: record.level === "error" ? "error" : record.level === "warning" ? "warning" : "info",
			});
		}
	}

	return {
		sessionId: latestString(records, "sessionId", "session_id"),
		cwd: latestString(records, "cwd"),
		version: latestString(records, "version"),
		events: events.filter((event) => event.kind !== "assistant" || event.blocks.length > 0),
	};
}
