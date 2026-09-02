-- dev/wezterm-gw.lua -- demo window config: loads the real gateway, everything else default.
-- Run: wezterm --config-file <repo>/dev/wezterm-gw.lua start --always-new-process
local wezterm = require 'wezterm'

-- Derive the repo root from the loaded config file's own path (wezterm.config_path);
-- no machine-specific paths hardcoded.
local dev = wezterm.config_path:match '^(.*)[/\\]'
local root = dev:match '^(.*)[/\\]'
dofile(root .. '/gateway/wezterm/ath-gateway.lua')

return {
  default_prog = { 'C:/Program Files/Git/bin/bash.exe', '-i', '-l' },
  window_close_confirmation = 'NeverPrompt',
}
