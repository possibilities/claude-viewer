# Development Rules

- Use Bun and strict TypeScript. Rust requires a demonstrated terminal capability that Bun cannot provide.
- The official Claude Code TUI is the rendering oracle. Do not substitute a house theme or redesign its transcript.
- Keep the live viewer chromeless and view-only: no product header, composer, status bar, help rail, or session writes.
- Never commit a real Claude session, prompt, tool output, or oracle capture. Fixtures must be synthetic or irreversibly redacted.
- Treat Claude JSONL as an unstable input format. Isolate compatibility handling in `src/session.ts` and `src/model.ts`.
- Unknown records and content blocks must be ignored without losing the rest of a transcript.
- Keep renderer behavior pure and snapshot-testable. Terminal I/O belongs in `src/viewer.ts`; official-client PTY work belongs in `src/oracle.ts`.
- Run `bun run check` after code changes. Run a local oracle comparison when changing observed layout or styling.
- Stage explicit paths only. Do not use `git add .` or `git add -A`.
