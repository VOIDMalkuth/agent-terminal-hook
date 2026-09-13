# ath-hud

A Windows floating HUD that shows what your coding agents are doing — one card per
session with live state (working / waiting for you / done), a tool-call timeline, and
model self-reports.

```
 agent CLIs (codex in WSL/SSH, ZCode local)
   │ hooks + ath_report MCP tool
   ▼
 ath-send ──OSC 1337──▶ WezTerm gateway ──HTTP──┐
 (JSON→base64→tty)      ath-gateway.lua         │
                                                ▼
 ZCode hooks ──────────HTTP 127.0.0.1:7301──▶ ath-hud (Tauri 2 floating window,
                                                token-authed local server)
```

The HUD is display-only. Agents never push actions back; the only local effect is an
optional sound when a session starts waiting for input.

## Repo layout

```
apps/hud/            Tauri 2 + React/TS floating window (HTTP server on 127.0.0.1:7301,
                     tray, edge docking, stale markers, reminder-free pure display)
packages/protocol/   ATH v1 message schema (zod) — single source of truth
gateway/wezterm/     Lua gateway: OSC 1337 SetUserVar -> decoded JSON -> HTTP POST
remote/              deployed on machines where agents run
  ath-send             one exit point: JSON -> base64 -> OSC 1337 -> /dev/tty (tmux-aware)
  ath-report-mcp/      MCP stdio server: ath_report(action, reason?, next?) tool
agents/              per-CLI bridges
  codex/               installer + lifecycle hooks + reminder injection (see codex/README.md)
  claude/              opt-in installer + hooks, http-only (see claude/README.md)
  zcode/               single hook script, direct HTTP
scripts/             dev utilities (icon generator, mock feed, OSC demo, packaging)
dev/                 test harness (event collector, OSC probe, gateway dev window)
```

## Quick start

**HUD (Windows):** `npm install` at repo root, then `npm run hud` (Tauri dev).
First launch generates `%APPDATA%\com.ath.hud\token`.

**Codex (WSL/Linux):** see `agents/codex/README.md` — it is one command plus
`/hooks` trust, provided the terminal pane runs inside a gateway-enabled WezTerm
window.

**ZCode (Windows):** point the seven hook events in `~/.zcode/cli/config.json` at
`agents/zcode/hook.mjs <EventName>` (async, exit 0). Events map 1:1; ZCode has no
SessionEnd, so sessions end via stale or manual delete.

**Claude Code (http-only):** see `agents/claude/README.md`. Not installed by
default — run `node agents/claude/install.mjs` explicitly. Claude hooks have no
controlling terminal on any platform, so this bridge always POSTs to the gateway
over HTTP; runtime deploys to `~/.ath/claude`.

**Remote SSH agents:** copy `remote/ath-send` to the host, call it from hooks or
scripts — the OSC rides the SSH byte stream into your local WezTerm gateway.

## Build & artifacts

Two commands from the repo root; outputs land in `dist/` (git-ignored). The
version's single source is `apps/hud/src-tauri/tauri.conf.json` — bump it there
(alongside the two `package.json` files) and tag releases `v<version>`.

**HUD — one file:**

```sh
npm run app:build
```

→ `dist/ath-hud-<version>.exe` — the whole app (frontend embedded). Needs the
WebView2 runtime, present on Windows 11 and updated Windows 10. Unsigned, so
other machines show a SmartScreen prompt: "More info → Run anyway". The HUD
process hosts the local gateway — it must be running for any of the transports
below to land.

**Agent side — tarball + gateway Lua:**

```sh
npm run pkg:agent
```

→ `dist/ath-agent-<version>.tar.gz` — codex + claude installers, hook bridges, MCP
server and ath-send in the repo's own layout. On the agent machine (WSL/Linux):
unpack anywhere, enter the folder, run `node agents/codex/install.mjs`, then trust
the hooks via `/hooks` in codex. Runtime files deploy to `~/.codex/ath` — the
unpacked folder can be deleted after install. Claude support is opt-in and
http-only: `node agents/claude/install.mjs` (deploys to `~/.ath/claude`).

→ `dist/ath-gateway-<version>.lua` — standalone copy of the WezTerm gateway. On
the Windows side, dofile it from `~/.wezterm.lua` (see `gateway/wezterm/README.md`).

## Debugging

| Switch | Scope |
|---|---|
| `ATH_DEBUG_LOG=<file>` | gateway (Lua) and ath-send append their traces to this file |
| `ATH_TRANSPORT=tty\|http` | force transport in codex hook / MCP server |
| `ATH_URL`, `ATH_TOKEN`, `ATH_SEND`, `ATH_TTY` | endpoint / token / binary overrides |
| `dev/test-collector.mjs` | standalone HTTP collector on 7301-style port for isolated tests |
| `dev/wezterm-gw.lua` | one-shot WezTerm window with the gateway preloaded |

Status and known limitations: native Windows codex hooks have no console, so the tty
transport is Linux/WSL/SSH only — use `ATH_TRANSPORT=http` there; background compaction
in ZCode emits no hook events at all; hosted tools (web search) bypass codex hooks and
leave gaps in the op timeline.
