# 0001 — Render sessions independently

`claude-viewer` parses Claude session JSONL and owns its terminal renderer instead of spawning and cropping the official client. This keeps the transcript surface view-only and usable without an attached Claude process; a PTY oracle harness measures drift without becoming a runtime dependency.
