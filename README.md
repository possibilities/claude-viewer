# claude-viewer

`claude-viewer` is a chromeless, view-only terminal viewer for Claude Code session transcripts. It renders a static
session or follows the session JSONL as Claude appends records, including Claude-like compact tool summaries,
expandable detailed tool output, Markdown, and edit diffs.

The renderer is an independent Bun/TypeScript implementation. Claude Code is not a runtime dependency unless you use
the optional oracle comparison harness.

This project is not affiliated with or endorsed by Anthropic.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 or newer
- A terminal with true-color support
- Claude Code only for `oracle capture`

## Install

```sh
git clone https://github.com/possibilities/claude-viewer.git
cd claude-viewer
bun install --frozen-lockfile
bun link
```

You can skip `bun link` and replace `claude-viewer` in the examples with `bun run src/cli.ts`.

## Use

Open a session by full ID, unique ID prefix, or JSONL path:

```sh
claude-viewer 8b06d821
claude-viewer ~/.claude/projects/-Users-me-project/session-id.jsonl
claude-viewer --session session-id --detailed
```

Session IDs are resolved recursively under `~/.claude/projects`. Use `--session-dir <dir>` for another Claude projects
directory. The viewer follows complete records appended to the file by default; a partially written final JSONL record
is ignored until the next update.

Print once without opening the alternate-screen TUI:

```sh
claude-viewer session-id --print
claude-viewer session-id --print --mode detailed --width 100 --color always
```

Useful options:

| Option | Effect |
| --- | --- |
| `--detailed` | Start with individual tool calls and available output expanded |
| `--mode compact\|detailed` | Select the initial rendering mode |
| `--no-follow` | Render the current snapshot without watching for appends |
| `--print` | Write one transcript to stdout instead of opening the TUI |
| `--color auto\|always\|never` | Control ANSI styling for `--print` |
| `--width <columns>` | Set the `--print` layout width |

The live surface intentionally has no title, composer, footer, status bar, or help rail.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `k`, `↓` / `j` | Scroll one row |
| `ctrl+u`, `ctrl+d` | Scroll half a page |
| `b`, `space` | Scroll one page |
| `g`, `G` | Jump to top or bottom |
| `{`, `}` | Jump to previous or next user prompt |
| `/` | Start a search; `enter` accepts and `escape` cancels |
| `n`, `N` | Jump to next or previous search match |
| `ctrl+o` | Toggle compact and detailed tool output |
| `[` | Print the full current transcript to terminal scrollback |
| `q`, `escape`, `ctrl+c` | Exit |

Mouse-wheel scrolling is also supported.

## What is rendered

| Transcript feature | Support |
| --- | --- |
| User prompts | Multiline wrapping and Claude-style full-row prompt background |
| Assistant text | Paragraphs, headings, emphasis, links, code, lists, quotes, rules, and tables |
| Compact tools | Consecutive successful reads and shell commands are grouped like Claude |
| Detailed tools | Tool name, arguments, available result content, failures, and multiline Bash calls |
| Edits | Update label, summary counts, line-numbered hunks, syntax color, and word-level change emphasis |
| Structured shell output | Complete JSON and JSONL records are pretty-printed and wrapped with Claude's terminal behavior |
| Session structure | Active branches, queued prompts, parallel tool-result rejoining, durations, and visible notices |
| Live sessions | Complete appended records are detected without modifying the source file |
| Unknown records | Ignored without discarding recognized content around them |

Tool types with known Claude presentations receive specialized summaries. Unknown tools still render their name and a
JSON representation of their input. Images and interactive permission/composer state are outside the transcript
surface and are not rendered.

## Privacy and safety

Normal viewing is local and read-only:

- The session file is read and optionally watched. It is never opened for writing.
- The viewer does not invoke Claude, execute transcript tool calls, or send transcript content over the network.
- No session content is included in the repository. Committed tests use synthetic fixtures.

Oracle captures are more sensitive. `oracle capture` launches the installed official Claude Code binary against a copy
of a real session inside a temporary `CLAUDE_CONFIG_DIR`. The harness:

- persists Claude's `Auto (match terminal)` theme choice and fullscreen TUI setting only in the disposable config;
- copies local Claude credentials into that config when authentication is required;
- invokes Claude with `--safe-mode` and disables nonessential traffic and automatic updates;
- protects the copied session and credentials with owner-only file modes;
- terminates the oracle process group and removes the disposable directory on success or failure.

An oracle frame contains real transcript cells and must be treated as private. `.oracle/` and test oracle JSON files are
gitignored; do not move captures into committed fixtures.

## Oracle comparison workflow

The official Claude Code TUI is the behavioral and visual oracle. Capture a representative real session at a fixed
terminal size:

```sh
claude-viewer oracle capture <session-id-or-path> \
  --out .oracle/example-120x40.json \
  --width 120 \
  --height 40
```

The session working directory is inferred from its records. Pass `--cwd <dir>` when it is absent or incorrect. Capture
metadata records the Claude version and capture method.

Compare the independent renderer with the captured frame:

```sh
claude-viewer oracle compare <session-id-or-path> .oracle/example-120x40.json
claude-viewer oracle compare <session-id-or-path> .oracle/example-120x40.json --json
```

Comparison reports text drift and style drift separately. It removes only documented capture artifacts and normalizes
Claude's volatile turn-duration verb; it does not use fuzzy matching. When Claude Code changes, recapture a small set of
representative sessions, inspect each difference, and add a synthetic regression test for any compatibility change.

## Known approximations

Claude's session format and closed-source TUI can change without notice. This release is tested against Claude Code
2.1.236, but compatibility handling is deliberately defensive.

- Terminal font metrics, locale-specific timestamps, and unsupported Markdown extensions can differ from Claude.
- Syntax highlighting covers common file extensions through `highlight.js`; unknown extensions use plain code styling.
- Specialized presentations for future or uncommon tools fall back to JSON arguments and text results.
- The viewer reproduces observed Claude transcript colors under `Auto (match terminal)`; it is not a configurable house
  theme and does not inherit unrelated application themes.

## Develop

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Biome, strict TypeScript checking, and the synthetic test suite. See
[`docs/adr/0001-independent-renderer.md`](docs/adr/0001-independent-renderer.md) for the core architecture decision.

## License

MIT
