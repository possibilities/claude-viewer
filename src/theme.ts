import type { TextStyle } from "./types.ts";

// These are observed Claude Code transcript colors, not a configurable application theme.
export const CLAUDE_COLORS = Object.freeze({
	text: "#ffffff",
	muted: "#999999",
	userBackground: "#373737",
	userMarker: "#505050",
	tool: "#4eba65",
	link: "#b1b9f9",
	warning: "#ffc107",
	error: "#ff6b80",
	code: "#f8f8f2",
	codeComment: "#75715e",
	codeKeyword: "#f92672",
	codeLiteral: "#be84ff",
	codeString: "#e6db74",
	codeType: "#66d9ef",
	codeFunction: "#a6e22e",
	diffAdd: "#50c850",
	diffAddBackground: "#022800",
	diffAddHighlight: "#044700",
	diffRemove: "#dc5a5a",
	diffRemoveBackground: "#3d0100",
	diffRemoveHighlight: "#5c0200",
});

export const CLAUDE_STYLES = Object.freeze({
	text: {} satisfies TextStyle,
	primary: { fg: CLAUDE_COLORS.text } satisfies TextStyle,
	muted: { fg: CLAUDE_COLORS.muted } satisfies TextStyle,
	mutedBold: { fg: CLAUDE_COLORS.muted, bold: true } satisfies TextStyle,
	tool: { fg: CLAUDE_COLORS.tool } satisfies TextStyle,
	link: { fg: CLAUDE_COLORS.link } satisfies TextStyle,
	code: { fg: CLAUDE_COLORS.code } satisfies TextStyle,
	warning: { fg: CLAUDE_COLORS.warning } satisfies TextStyle,
	error: { fg: CLAUDE_COLORS.error } satisfies TextStyle,
	user: { fg: CLAUDE_COLORS.text, bg: CLAUDE_COLORS.userBackground } satisfies TextStyle,
	userMarker: { fg: CLAUDE_COLORS.userMarker, bg: CLAUDE_COLORS.userBackground } satisfies TextStyle,
});
