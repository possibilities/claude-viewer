import { type Dirent, existsSync, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { RawSessionRecord, SessionSnapshot } from "./types.ts";

function isObject(value: unknown): value is RawSessionRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: RawSessionRecord, name: string): string | undefined {
	const value = record[name];
	return typeof value === "string" ? value : undefined;
}

export function parseSessionText(text: string): RawSessionRecord[] {
	const records: RawSessionRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isObject(parsed)) records.push(parsed);
		} catch {
			// Claude appends JSONL records non-atomically. A partial final record is retried on the next file update.
		}
	}
	return records;
}

export function selectActiveBranch(records: readonly RawSessionRecord[]): RawSessionRecord[] {
	const byUuid = new Map<string, RawSessionRecord>();
	for (const record of records) {
		const uuid = stringField(record, "uuid");
		if (uuid) byUuid.set(uuid, record);
	}

	let leaf: string | undefined;
	for (let index = records.length - 1; index >= 0; index--) {
		const candidate = stringField(records[index] ?? {}, "leafUuid");
		if (candidate && byUuid.has(candidate)) {
			leaf = candidate;
			break;
		}
	}
	if (!leaf) {
		for (let index = records.length - 1; index >= 0; index--) {
			const candidate = stringField(records[index] ?? {}, "uuid");
			if (candidate) {
				leaf = candidate;
				break;
			}
		}
	}
	if (!leaf) return [...records];

	const branch: RawSessionRecord[] = [];
	const visited = new Set<string>();
	let current: string | undefined = leaf;
	while (current && !visited.has(current)) {
		visited.add(current);
		const record = byUuid.get(current);
		if (!record) break;
		branch.push(record);
		current = stringField(record, "parentUuid");
	}
	branch.reverse();

	// Imported and very old sessions sometimes omit parent links. File order is more useful than a one-record branch.
	return branch.length > 1 ? branch : [...records];
}

export function readSessionSnapshot(path: string): SessionSnapshot {
	return {
		path,
		records: parseSessionText(readFileSync(path, "utf8")),
	};
}

export function defaultProjectsDirectory(): string {
	const configDirectory = process.env.CLAUDE_CONFIG_DIR;
	return resolve(configDirectory ?? join(homedir(), ".claude"), "projects");
}

function looksLikePath(input: string): boolean {
	return isAbsolute(input) || input.includes("/") || input.includes("\\") || extname(input) === ".jsonl";
}

async function collectSessionFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(current: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	}
	await visit(directory);
	return files;
}

export async function resolveSessionFile(
	input: string,
	projectsDirectory = defaultProjectsDirectory(),
): Promise<string> {
	if (looksLikePath(input)) {
		const candidate = resolve(input);
		if (!existsSync(candidate) || !statSync(candidate).isFile()) {
			throw new Error(`Session file not found: ${candidate}`);
		}
		return candidate;
	}

	const files = await collectSessionFiles(projectsDirectory);
	const exact = files.filter((path) => basename(path, ".jsonl") === input);
	if (exact.length === 1) return exact[0] as string;
	if (exact.length > 1) throw new Error(`Session ID is not unique: ${input}`);

	const prefix = files.filter((path) => basename(path, ".jsonl").startsWith(input));
	if (prefix.length === 1) return prefix[0] as string;
	if (prefix.length > 1) {
		const examples = prefix.slice(0, 5).map((path) => basename(path, ".jsonl"));
		throw new Error(
			`Session ID prefix is ambiguous: ${input} (${examples.join(", ")}${prefix.length > 5 ? ", …" : ""})`,
		);
	}
	throw new Error(`Session not found: ${input}`);
}

export class SessionFollower {
	readonly #path: string;
	#listener: (() => void) | undefined;
	#fingerprint: string | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	start(onSnapshot: (snapshot: SessionSnapshot) => void): void {
		if (this.#listener) return;
		const publish = (): void => {
			const snapshot = readSessionSnapshot(this.#path);
			const finalRecord = snapshot.records.at(-1);
			const fingerprint = `${snapshot.records.length}\0${finalRecord ? JSON.stringify(finalRecord) : ""}`;
			if (fingerprint === this.#fingerprint) return;
			this.#fingerprint = fingerprint;
			onSnapshot(snapshot);
		};
		this.#listener = publish;
		publish();
		watchFile(this.#path, { interval: 100 }, publish);
	}

	stop(): void {
		if (!this.#listener) return;
		unwatchFile(this.#path, this.#listener);
		this.#listener = undefined;
	}
}
