-- dev/osc-probe.lua -- end-to-end probe: loads the real gateway ath-gateway.lua,
-- the pane's emitter sends a full session flow, verifying OSC 1337 -> gateway -> HUD.
-- Forwarded/dropped payloads land in the file ATH_DEBUG_LOG points to (passed via env).
-- Run: wezterm --config-file <repo>/dev/osc-probe.lua start --always-new-process
local wezterm = require 'wezterm'

-- Derive the repo root from the loaded config file's own path (wezterm.config_path);
-- no machine-specific paths hardcoded.
local dev = wezterm.config_path:match '^(.*)[/\\]'
local root = dev:match '^(.*)[/\\]'
dofile(root .. '/gateway/wezterm/ath-gateway.lua')

return {
  default_prog = {
    'C:/Program Files/nodejs/node.exe',
    root .. '/dev/osc-emit.mjs',
  },
  window_close_confirmation = 'NeverPrompt',
}
