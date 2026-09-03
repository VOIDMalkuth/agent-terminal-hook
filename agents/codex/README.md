# ath-hud for Codex

One command installs the ath-hud integration for Codex CLI. Another one removes it.

What you get:

- **Lifecycle hooks** (`~/.codex/hooks.json`) — session cards on the HUD:
  register/working per turn, tool-call timeline paired by `tool_use_id`,
  waiting on permission prompts, turn end and interrupts, `bye` on session end.
- **Reminder injection** — `SessionStart` establishes the self-report convention and
  hands the model its session sid; `PostToolUse` injects a reminder when no `ath_report`
  call happened for 5 minutes. Timer state lives in `~/.codex/ath_report/<sess_id>.json`
  (sid, cwd, timers; auto-cleaned after 7 days).
- **`ath_report` MCP tool** (`[mcp_servers.ath]` in `config.toml`) — the model calls
  `ath_report(action, reason?, next?, sid?)`, echoing the injected sid so reports land
  on the right card; the report shows up as the card's self-description.
- **`ath-send`** copied to `~/.local/bin` — the single exit point that turns JSON into an
  `OSC 1337` sequence on the terminal.
- **tmux passthrough** — `set -g allow-passthrough on` added to `~/.tmux.conf`
  (idempotent; apply to a running server with `tmux source-file ~/.tmux.conf`).

## Requirements

- Linux environment with codex CLI and node >= 18 (native Linux or WSL).
  Native Windows codex is NOT supported: its hook processes have no console, so the
  tty write fails.
- A WezTerm window whose config loads `gateway/wezterm/ath-gateway.lua` — the OSC
  bytes are picked up there — with the ath-hud app running on the Windows side.
- If codex runs over SSH, that's fine too: the OSC travels inside the SSH byte stream.

## Install

Inside the Linux environment (WSL counts):

```sh
node agents/codex/install.mjs
```

The installer is idempotent and backs up a foreign `hooks.json` before replacing
it. Runtime files deploy to `~/.codex/ath` — if that folder already exists the
installer asks before overwriting (skip the prompt with `--yes`), and the
unpacked package folder can be deleted right after installing.
Then:

1. Restart running codex sessions.
2. In codex TUI run `/hooks` once and **trust** the ath-hud hooks (hash-based trust;
   repeat after every change to `hooks.json`).
3. Start a task — a `codex:<uuid>` card appears on the HUD.

## Uninstall

```sh
node agents/codex/install.mjs uninstall
```

Removes `hooks.json`, the `[mcp_servers.ath]` block and the `~/.codex/ath`
runtime. Left alone on purpose: `~/.local/bin/ath-send`, `~/.codex/ath_report/`
timer state, and orphaned trust entries inside codex's own state (harmless).

## Environment switches

| Variable | Effect |
|---|---|
| `ATH_TRANSPORT=http` | Direct HTTP to the gateway instead of tty/OSC (debug; normal path is tty) |
| `ATH_DEBUG_LOG=<file>` | Gateway and ath-send append their traces to this file |

Hooks themselves are silent by contract: no retries, no queues, always exit 0.
