# Glossary

**Session** — A persisted Claude Code JSONL conversation and its branch metadata. A session is input and is never modified by the viewer.

_Avoid_: log, rollout

**Transcript** — The active visible branch derived from a session: user messages, assistant output, tool calls and results, and visible system events.

_Avoid_: chat log, raw JSONL

**Transcript surface** — The chromeless, view-only terminal interface that renders a transcript and follows complete new session records.

_Avoid_: dashboard, Claude shell

**Compact mode** — The Claude-like default presentation that groups routine tool activity such as reads and shell commands.

_Avoid_: collapsed transcript

**Detailed mode** — The `ctrl+o` presentation that renders individual tool calls and their available outputs.

_Avoid_: debug mode, verbose log

**Oracle** — The installed official Claude Code TUI resumed against a real session solely as behavioral and visual evidence.

_Avoid_: dependency, backend

**Oracle frame** — A fixed-size terminal cell grid captured from the oracle, including text, color, and attributes. Oracle frames can contain private transcript data and stay local.

_Avoid_: golden fixture, screenshot

**Fixture** — Synthetic or irreversibly redacted JSONL committed for deterministic parser and renderer tests.

_Avoid_: captured session

**Frame normalization** — A documented transformation that removes known oracle volatility, such as Claude's randomly selected turn-duration verb, before comparison.

_Avoid_: fuzzy matching
