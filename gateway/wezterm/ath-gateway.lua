-- ath-gateway.lua -- WezTerm -> ath-hud local gateway (design.md §4).
--
-- Pure transport: OSC 1337 SetUserVar(name=ATH) -> validate JSON -> (reassemble
-- fragments) -> POST to the gateway. No business logic in Lua.
--
-- Measured behavior (wezterm 20240203-110809-5046fc22, Windows):
--   * the user-var-changed value is ALREADY base64-decoded — never decode again;
--     the stable build also has no wezterm.base64_decode/base64_encode (both nil).
--   * events may not fire during the first ~1s of a fresh window (startup race);
--     irrelevant for agents in long-lived windows.
--   * base64 the whole envelope once at the OSC layer; inner `data` fragments stay
--     raw JSON text so Lua needs no decoding capability.
--
-- Setup (either):
--   1. paste this file's body into ~/.wezterm.lua; or
--   2. add one line to ~/.wezterm.lua:
--      dofile('C:/path/to/agent-hook/gateway/wezterm/ath-gateway.lua')
--
-- Env (of the GUI process): ATH_URL overrides the endpoint (default
-- http://127.0.0.1:7301/event); ATH_DEBUG_LOG=<file> appends every forwarded payload.
-- Token read order: ATH_TOKEN env -> %APPDATA%\com.ath.hud\token (created by ath-hud).
-- Fragment protocol (reserved): outer {v=1,id,seq,tot,data}, data = raw-text fragment.

local wezterm = require 'wezterm'

local ENDPOINT = os.getenv('ATH_URL')
if not ENDPOINT or ENDPOINT == '' then
  ENDPOINT = 'http://127.0.0.1:7301/event'
end
local VAR_NAME = 'ATH'
local token_cache = nil
local buf = {} -- id -> { [seq] = raw fragment, tot = n }
local tmp_seq = 0

local function debug_log(line)
  local path = os.getenv('ATH_DEBUG_LOG')
  if not path or path == '' then
    return
  end
  local f = io.open(path, 'a')
  if f then
    f:write(line .. '\n')
    f:close()
  end
end

local function read_token()
  if token_cache and token_cache ~= '' then
    return token_cache
  end
  local env = os.getenv('ATH_TOKEN')
  if env and env ~= '' then
    token_cache = env
    return env
  end
  local appdata = os.getenv('APPDATA')
  if appdata then
    local f = io.open(appdata .. '\\com.ath.hud\\token', 'r')
    if f then
      local t = f:read('*l') or ''
      f:close()
      t = t:gsub('%s+', '')
      if t ~= '' then
        token_cache = t
        return t
      end
    end
  end
  return nil
end

local function post_raw(raw, tag)
  debug_log('POST[' .. tostring(tag) .. '] ' .. raw)
  local token = read_token()
  if not token then
    wezterm.log_error('[ath] 未找到 token：设 ATH_TOKEN 或 %APPDATA%\\com.ath.hud\\token')
    return
  end
  local sep = package.config:sub(1, 1)
  local base = os.getenv('TEMP') or '/tmp'
  tmp_seq = (tmp_seq + 1) % 1000
  local path = base .. sep .. 'ath-' .. tostring(os.time()) .. '-' .. tostring(tmp_seq) .. '-' .. tostring(tag) .. '.json'
  local f = io.open(path, 'wb')
  if not f then
    wezterm.log_error('[ath] 无法写临时文件: ' .. path)
    return
  end
  f:write(raw)
  f:close()
  -- curl.exe ships with Windows 10 1803+. run_child_process waits for the child
  -- (loopback is normally ms; -m 3 caps the worst case).
  wezterm.run_child_process {
    'curl.exe', '-s', '-o', 'NUL', '-m', '3',
    '-X', 'POST', ENDPOINT,
    '-H', 'Content-Type: application/json',
    '-H', 'X-Ath-Token: ' .. token,
    '--data-binary', '@' .. path,
  }
  os.remove(path)
end

wezterm.on('user-var-changed', function(window, pane, name, value)
  if name ~= VAR_NAME then
    return
  end
  -- value is already decoded by WezTerm (see header); validate as JSON directly
  if type(value) ~= 'string' or #value == 0 then
    return
  end
  local pok, msg = pcall(wezterm.json_parse, value)
  if not pok or type(msg) ~= 'table' or msg.v ~= 1 then
    debug_log('DROP[bad-json] ' .. value)
    return
  end

  -- fragmented message: buffer by id, reassemble in seq order once tot pieces arrived
  if msg.tot and msg.tot > 1 and msg.id and msg.seq and msg.data then
    local chunk = msg.data
    if type(chunk) ~= 'string' then
      return
    end
    local b = buf[msg.id] or { tot = msg.tot }
    b.tot = msg.tot
    b[msg.seq] = chunk
    buf[msg.id] = b
    local n = 0
    for k, _ in pairs(b) do
      if type(k) == 'number' then
        n = n + 1
      end
    end
    if n >= msg.tot then
      buf[msg.id] = nil
      local parts = {}
      for i = 1, msg.tot do
        parts[#parts + 1] = b[i] or ''
      end
      post_raw(table.concat(parts), msg.id)
    end
    return
  end

  -- single-piece message: forward as-is
  post_raw(value, 's')
end)
