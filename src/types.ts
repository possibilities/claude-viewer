export type JsonObject = Record<string, unknown>;

export type RawSessionRecord = JsonObject;

export interface SessionSnapshot {
	path: string;
	records: RawSessionRecord[];
}

export interface ToolResult {
	toolUseId: string;
	content: string;
	isError: boolean;
	details: JsonObject | undefined;
}

export interface TextBlock {
	kind: "text";
	text: string;
}

export interface ToolBlock {
	kind: "tool";
	id: string;
	name: string;
	input: JsonObject;
	result: ToolResult | undefined;
}

export type AssistantBlock = TextBlock | ToolBlock;

export interface UserEvent {
	kind: "user";
	id: string;
	text: string;
	timestamp: string | undefined;
}

export interface AssistantEvent {
	kind: "assistant";
	id: string;
	model: string | undefined;
	timestamp: string | undefined;
	blocks: AssistantBlock[];
}

export interface DurationEvent {
	kind: "duration";
	id: string;
	durationMs: number;
	timestamp: string | undefined;
}

export interface NoticeEvent {
	kind: "notice";
	id: string;
	text: string;
	level: "info" | "warning" | "error";
}

export type TranscriptEvent = UserEvent | AssistantEvent | DurationEvent | NoticeEvent;

export interface Transcript {
	sessionId: string | undefined;
	cwd: string | undefined;
	version: string | undefined;
	events: TranscriptEvent[];
}

export interface TextStyle {
	fg?: string | number;
	bg?: string | number;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
}

export interface StyledSpan {
	text: string;
	style?: TextStyle;
}

export type StyledLine = StyledSpan[];

export interface FrameCell {
	text: string;
	width: number;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
}

export interface TerminalFrame {
	schemaVersion: 1;
	width: number;
	height: number;
	rows: FrameCell[][];
	metadata: Record<string, string | number | boolean | null>;
}

export type RenderMode = "compact" | "detailed";

export interface TranscriptDocument {
	lines: StyledLine[];
	promptRows: number[];
}

export interface FrameDifference {
	kind: "added" | "removed" | "changed" | "style";
	expectedRow: number | undefined;
	actualRow: number | undefined;
	expectedText: string | undefined;
	actualText: string | undefined;
	expectedStyle?: string;
	actualStyle?: string;
}

export interface FrameComparison {
	match: boolean;
	expectedRows: number;
	actualRows: number;
	matchingTextRows: number;
	textMismatchRows: number;
	styleMismatchRows: number;
	differenceCount: number;
	differences: FrameDifference[];
}
