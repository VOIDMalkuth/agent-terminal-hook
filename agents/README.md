# agents/ — per-CLI bridges to ath-hud

Each subdirectory integrates one agent CLI with the ath-hud floating window.

| Dir | CLI | Transport | Notes |
|---|---|---|---|
| `codex/` | OpenAI Codex CLI | OSC 1337 via `ath-send` (tty) | One-shot installer, lifecycle hooks, reminder injection, MCP tool registration. See `codex/README.md`. |
| `zcode/` | ZCode CLI | Direct HTTP to 127.0.0.1:7301 | Single `hook.mjs`, registered manually in `~/.zcode/cli/config.json`. Windows-local only. |

Shared contract: both hooks read one JSON object on stdin, emit ATH v1 messages
(see `packages/protocol`), and never block the CLI — no retries, no queues, exit 0.
