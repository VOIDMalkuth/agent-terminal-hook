#!/usr/bin/env node
// ath-hud ↔ Codex one-shot installer/uninstaller.
//
//   node install.mjs            install (hooks.json + [mcp_servers.ath] + ath-send to ~/.local/bin)
//   node install.mjs uninstall  remove everything this script manages
//
// Managed artifacts are marked with the string "ath-hud" so re-runs are idempotent
// and uninstall never touches foreign config. A pre-existing foreign hooks.json is
// backed up to hooks.json.bak.<ts> before being replaced.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'ath-hud';
const DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(DIR, 'hook.mjs').replace(/\\/g, '/');
const SERVER_PATH = join(DIR, '..', '..', 'remote', 'ath-report-mcp', 'server.mjs').replace(/\\/g, '/');
const ATH_SEND_SRC = join(DIR, '..', '..', 'remote', 'ath-send');
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const LOCAL_BIN = join(homedir(), '.local', 'bin');

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
];

function hooksConfig() {
  const hooks = {};
  for (const ev of EVENTS) {
    hooks[ev] = [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${HOOK_PATH}" ${ev}`,
            timeout: ev === 'SessionEnd' ? 3 : 10,
            statusMessage: 'reporting to ath-hud',
          },
        ],
      },
    ];
  }
  return { description: `${MARKER} bridge: Codex lifecycle -> agents/codex/hook.mjs (tty via ath-send on PATH; ATH_TRANSPORT=http for direct HTTP)`, hooks };
}

function stripAthTomlBlocks(text) {
  // Remove the [mcp_servers.ath] block — marked (marker comment lines included)
  // or legacy unmarked — up to the next foreign table header or EOF.
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      // another [mcp_servers.ath] header while skipping is still ours; any other
      // table header ends the block
      if (/^\s*\[(?!\s*mcp_servers\.ath\])/.test(line)) skipping = false;
      else continue;
    }
    if (/^\s*\[mcp_servers\.ath\]\s*$/.test(line) || /^\s*# >>> ath-hud begin/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

function install() {
  mkdirSync(CODEX_HOME, { recursive: true });

  // 1. hooks.json
  const hooksFile = join(CODEX_HOME, 'hooks.json');
  if (existsSync(hooksFile) && !readFileSync(hooksFile, 'utf8').includes(MARKER)) {
    const bak = `${hooksFile}.bak.${Date.now()}`;
    copyFileSync(hooksFile, bak);
    console.log(`[i] existing foreign hooks.json backed up -> ${bak}`);
  }
  writeFileSync(hooksFile, JSON.stringify(hooksConfig(), null, 2) + '\n');
  console.log(`[+] hooks.json written (${EVENTS.length} events, all synchronous)`);

  // 2. MCP server registration in config.toml
  const tomlFile = join(CODEX_HOME, 'config.toml');
  const toml = existsSync(tomlFile) ? readFileSync(tomlFile, 'utf8') : '';
  const cleaned = stripAthTomlBlocks(toml);
  const block = [
    `# >>> ${MARKER} begin (managed by agents/codex/install.mjs) >>>`,
    '[mcp_servers.ath]',
    'command = "node"',
    `args = ["${SERVER_PATH}"]`,
    // codex spawns MCP servers with a whitelist of the parent env; forward the
    // tmux markers (ath-send wraps OSC only inside tmux) and our overrides
    'env_vars = ["TMUX", "TMUX_PANE", "ATH_URL", "ATH_TRANSPORT", "ATH_SEND", "ATH_TOKEN"]',
    `# <<< ${MARKER} end <<<`,
    '',
  ].join('\n');
  writeFileSync(tomlFile, cleaned.endsWith('\n') || cleaned === '' ? cleaned + block : cleaned + '\n' + block);
  console.log('[+] config.toml: [mcp_servers.ath] registered (idempotent)');

  // 3. ath-send -> ~/.local/bin (hooks call it via PATH)
  if (existsSync(ATH_SEND_SRC)) {
    mkdirSync(LOCAL_BIN, { recursive: true });
    const dst = join(LOCAL_BIN, 'ath-send');
    // a CRLF checkout must never reach the deployed copy: sh breaks on trailing \r
    const body = readFileSync(ATH_SEND_SRC, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(dst, body, { mode: 0o755 });
    try {
      chmodSync(dst, 0o755);
    } catch {}
    console.log(`[+] ath-send copied -> ${dst}`);
    if (!process.env.PATH.split(/:/).includes(LOCAL_BIN)) {
      console.log(`[!] ${LOCAL_BIN} is not on PATH. Fix with:`);
      console.log(`    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`);
    }
  } else {
    console.log(`[!] ath-send not found at ${ATH_SEND_SRC} — tty transport will not work until it is on PATH`);
  }

  // 4. tmux: ensure OSC passthrough is enabled in the rc file (idempotent)
  const tmuxConf = join(homedir(), '.tmux.conf');
  const passLine = 'set -g allow-passthrough on';
  let cur = '';
  try {
    cur = readFileSync(tmuxConf, 'utf8');
  } catch {
    /* no rc file yet */
  }
  if (cur.split('\n').map((s) => s.trim()).includes(passLine)) {
    console.log(`[i] tmux passthrough already enabled in ${tmuxConf}`);
  } else {
    writeFileSync(
      tmuxConf,
      (cur ? cur.replace(/\n*$/, '\n') : '') + `# ath-hud: enable OSC 1337 passthrough\n${passLine}\n`,
    );
    console.log(`[+] tmux passthrough written -> ${tmuxConf} (restart tmux or: tmux source-file ${tmuxConf})`);
  }

  console.log(`
Next steps:
  1. Restart any running codex sessions.
  2. Run /hooks inside codex TUI once and trust the ${MARKER} hooks (hash-based trust;
     re-trust after every change to hooks.json).
  3. The tty transport needs a TTY: run codex inside WSL/SSH, and make sure that pane
     lives in a WezTerm window whose config loads gateway/wezterm/ath-gateway.lua,
     with the ath-hud app running on the Windows side.
  4. Optional debug: set ATH_DEBUG_LOG=<file> — gateway + ath-send append their traces there.`);
}

function uninstall() {
  const hooksFile = join(CODEX_HOME, 'hooks.json');
  if (existsSync(hooksFile)) {
    const txt = readFileSync(hooksFile, 'utf8');
    if (txt.includes(MARKER)) {
      rmSync(hooksFile);
      console.log(`[-] hooks.json removed`);
    } else {
      console.log(`[!] hooks.json is not ${MARKER}-managed, left untouched`);
    }
  }
  const tomlFile = join(CODEX_HOME, 'config.toml');
  if (existsSync(tomlFile)) {
    writeFileSync(tomlFile, stripAthTomlBlocks(readFileSync(tomlFile, 'utf8')));
    console.log(`[-] config.toml: [mcp_servers.ath] removed`);
  }
  console.log(`[i] left alone: ~/.local/bin/ath-send, ~/.codex/ath_report/ timer state,
    and any trusted-hook entries inside codex state (harmless orphans).`);
}

const cmd = process.argv[2] ?? 'install';
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else {
  console.error('usage: node install.mjs [install|uninstall]');
  process.exit(1);
}
