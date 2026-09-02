# ath-hud design

## 1. Goal

A Windows floating HUD that mirrors what coding agents (Codex, ZCode, others) are
doing: per-session cards with live state, a tool-call timeline, and model
self-reports. Display-only — agents never push actions back.

## 2. Architecture

Three collection paths converge on one local HTTP endpoint:

1. **Codex (WSL/Linux)** — lifecycle hooks (`agents/codex/hook.mjs`) and the
   `ath_report` MCP tool (`remote/ath-report-mcp/`) emit JSON through
   `remote/ath-send`, which writes an OSC 1337 sequence to `/dev/tty`. The byte
   stream reaches the WezTerm window the agent runs in; its Lua gateway
   (`gateway/wezterm/ath-gateway.lua`) decodes it and POSTs to the HUD.
2. **ZCode (Windows local)** — hooks (`agents/zcode/hook.mjs`) POST directly to
   `http://127.0.0.1:7301/event`. No OSC needed.
3. **Remote SSH agents** — same as (1); the OSC rides the SSH byte stream.

The HUD itself (`apps/hud`, Tauri 2) runs the token-authed server on
`127.0.0.1:7301` and renders cards. Native Windows codex is not supported on the
OSC path: its hook processes have no console, so `/dev/tty` is unwritable —
use `ATH_TRANSPORT=http` locally.

## 3. Channel

- Carrier: `ESC ] 1337 ; SetUserVar = ATH = <base64(JSON)> BEL`
- WezTerm decodes base64 itself; the Lua `user-var-changed` handler receives the
  plain JSON (verified on wezterm 20240203: no second decode, and the
  `wezterm.base64_decode` API does not exist in that build).
- Events within the first ~1s of a fresh WezTerm window may not fire (startup
  race) — irrelevant for long-lived sessions.
- Chunking is reserved: `{v,id,seq,tot,data}` with `data` as raw-text fragments
  (the envelope is already base64'd once at the OSC layer).
- Empirically required: `tmux allow-passthrough on` (tmux >= 3.3 defaults off).

## 4. ATH v1 messages (`packages/protocol`)

```
register  { state? }         new card, defaults to waiting_input
state     { state }          working | waiting_input | done
op        { tool, summary?, key?, phase: start|end, ok? }   tool-call timeline
report    { summary, reason?, next? }                       model self-description
bye                          session ended (Codex only; ZCode lacks SessionEnd)
```

Every message carries `sid` (`<agent>:<session uuid>`), `cwd`, `title` so the HUD
can rebuild a card from any single message after a restart. `sid` is the only
aggregation key — tmux/SSH reconnects keep the same card.

## 5. HUD semantics

- `op` arrivals imply working; start/end pair by `key` (toolCallId), fallback
  FIFO by tool name. Codex has no failure event; ZCode marks failures via
  `PostToolUseFailure` with `ok:false`.
- `waiting_input` sources: registration, permission requests, turn end.
  Optional local beep. Periodic ripple every 3 minutes while waiting (stops at
  stale), in both expanded cards and the collapsed edge strip.
- `stale` (default on, toggleable): no messages for 1h — gray badge, delete
  button pinned; manual ⚑ mark supported, cleared by any new message.
- `done`: single line for 5s + 1s fade, then removed.
- Collapsed mode: 30px strip docked to any screen edge; click the dot center to
  expand, everything else drags; tray menu offers reset-position and quit.
- No action channel: the HUD never triggers popups, clipboard, or links.

## 6. Self-report loop (Codex)

`SessionStart` hook injects the reporting convention plus the session's sid as
`additionalContext`; `PostToolUse` acts as a deterministic timer — after 5
minutes without an `ath_report` call it injects a reminder whose text demands
the model continue the task seamlessly after reporting. `ath_report` arrivals
reset the timer. The model echoes the sid back as the tool's `sid` argument;
the MCP server accepts it only if a matching timer-state file exists, then
falls back to a cwd match, then to the newest state file. State:
`~/.codex/ath_report/<sess_id>.json` (sid, cwd, timers; 7-day cleanup). The
MCP server and the hook both observe the call, so report delivery and timer
reset survive even if one channel is missing. All hooks run synchronously; all
are silent unless injected. Installer: `agents/codex/install.mjs` (idempotent,
marked blocks, `uninstall` subcommand).

## 7. Security

Local-only server bound to 127.0.0.1 with a static token
(`%APPDATA%\com.ath.hud\token`). The OSC channel is unauthenticated — safety
comes from the receiving side: loopback bind + token + display-only semantics.

## 8. Known limitations

- Hosted tools (web search etc.) bypass codex hooks — op timeline has gaps.
- Codex has no tool-failure hook; failures are not marked on the timeline.
- ZCode background compaction emits no events (register defaults to
  waiting_input, so nothing sticks at working).
- A fresh WezTerm window drops OSC-set vars in the first ~1s (startup race).
- SessionEnd (Codex): codex caps the hook at 3s (the installer configures 3);
  `bye` is written to the tty (`sendTty` capped at 2.5s), never fetched over HTTP.
