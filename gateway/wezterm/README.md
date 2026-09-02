# WezTerm Lua gateway

The `user-var-changed` event is the only Windows-side entry point of the OSC
path. This script just ferries data: validate JSON -> (re-assemble chunks) ->
`curl.exe` POST to `http://127.0.0.1:7301/event`.

Verified behavior (wezterm 20240203-110809-5046fc22, Windows, 2026-09-01):

- The `value` passed to `user-var-changed` is **already base64-decoded** by
  WezTerm — never decode again. That build also lacks
  `wezterm.base64_decode`/`base64_encode` entirely.
- Events do not fire during the first ~1s of a fresh window (startup race).
  Irrelevant for agents inside long-lived windows.

## Hook it up

Minimal complete `~/.wezterm.lua` — the `dofile` line is all ath-hud needs; the
rest is a normal config:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- ath-hud: OSC 1337 SetUserVar(ATH) -> decode -> POST http://127.0.0.1:7301/event
dofile('C:/path/to/agent-hook/gateway/wezterm/ath-gateway.lua')

config.window_close_confirmation = 'NeverPrompt'
return config
```

Notes:

- `ath-gateway.lua` only registers a `user-var-changed` handler; it returns
  nothing, so `dofile` it anywhere before `return config` and keep your own
  `default_prog`, colors, keybindings etc. as usual.
- Alternative: paste the file body inline into `~/.wezterm.lua` (same effect).
- For a disposable test window with the gateway preloaded (uses your normal
  shell, isolated from your real config):

```sh
wezterm --config-file dev/wezterm-gw.lua start --always-new-process
```

- Why a separate file at all: the event handler must be registered in every
  WezTerm window whose panes host agents; panes in a window without the gateway
  silently drop the OSC (no handler = no POST).

## Token

Read order: `ATH_TOKEN` env -> `%APPDATA%\com.ath.hud\token` (generated on first
ath-hud launch; also copyable from the HUD settings panel).

## Verify

From any pane of a gateway-enabled window:

```sh
echo '{"v":1,"type":"register","sid":"test:1","title":"link test"}' | ath-send
```

A `test:1` card on the HUD means the link works. Without ath-send, open the
WezTerm debug console (Ctrl+Shift+L) and pass the JSON string directly — the
value must be plain JSON, matching the real event shape:

```lua
wezterm.emit('user-var-changed', nil, nil, 'ATH',
  '{"v":1,"type":"register","sid":"test:1","title":"link test"}')
```

Env switches: `ATH_DEBUG_LOG=<file>` appends every forwarded/dropped payload;
`ATH_URL` overrides the endpoint. Chunked envelopes use raw-text fragments in
`data` (the whole envelope is base64'd once at the OSC layer).
