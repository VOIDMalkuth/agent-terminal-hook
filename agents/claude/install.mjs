#!/usr/bin/env node
// ath-hud ↔ Claude Code opt-in installer/uninstaller. NOT run by the default
// install — claude support is http-only and must be installed explicitly:
//
//   node install.mjs            install (runtime -> ~/.ath/claude + hooks into ~/.claude/settings.json)
//   node install.mjs uninstall  remove everything this script manages
//   --yes/-y                    skip the overwrite prompt
//
// Claude support is http-only by design: claude hooks run without a controlling
// terminal on every platform (no /dev/tty to write) and the terminalSequence
// escape hatch rejects OSC 1337, so the codex bridge's ath-send/tty path cannot
// exist here. Events go straight to the local gateway over HTTP, which requires
// the ath-hud app to be reachable at ATH_URL (default 127.0.0.1:7301) from the
// machine claude runs on.
//
// settings.json is shared user config: the install is merge-style and only ever
// touches hook entries pointing at the deployed hook path — foreign hooks are
// preserved untouched. The deployed runtime lives in ~/.ath/claude, so the
// extracted package can be deleted right after install.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'ath-hud';
const DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
// fixed deploy root: ~/.ath/<agent>/ so several agents can share the tree
const DEPLOY_DIR = join(homedir(), '.ath', 'claude');
const HOOK_DST = join(DEPLOY_DIR, 'hook.mjs');
const HOOK_PATH = HOOK_DST.replace(/\\/g, '/');
const ASSUME_YES = process.argv.includes('--yes') || process.argv.includes('-y');

// Notification gets a matcher group (idle_prompt only); SessionEnd gets a longer
// timeout — claude's default SessionEnd budget is a shared 1.5 seconds and the bye
// needs to fit. Everything else uses claude's defaults.
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'Notification',
  'SessionEnd',
];

function hookHandler() {
  return { type: 'command', command: 'node', args: [HOOK_PATH] };
}

function managedGroup(ev) {
  const group = { hooks: [hookHandler()] };
  if (ev === 'Notification') group.matcher = 'idle_prompt';
  if (ev === 'SessionEnd') group.hooks[0].timeout = 10;
  return group;
}

// A matcher-group is ours when any of its handlers references the deployed hook
// path — foreign groups never contain it, so they are preserved untouched.
function isOurs(group) {
  return JSON.stringify(group).includes(HOOK_PATH);
}

function mergeHooks(settings) {
  const hooks = (settings.hooks = settings.hooks ?? {});
  for (const ev of EVENTS) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev].filter((g) => !isOurs(g)) : [];
    groups.push(managedGroup(ev));
    hooks[ev] = groups;
  }
}

function stripHooks(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  let removed = false;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const kept = hooks[ev].filter((g) => !isOurs(g));
    if (kept.length !== hooks[ev].length) removed = true;
    if (kept.length === 0) delete hooks[ev];
    else hooks[ev] = kept;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

// Ask before replacing an existing deployment unless --yes/-y was passed.
// The question goes through console.log (readline's inline prompt does not
// render on every Linux TTY) and the answer is read as one raw stdin line.
async function confirmOverwrite() {
  if (ASSUME_YES || !existsSync(DEPLOY_DIR)) return true;
  console.log(`[?] ${DEPLOY_DIR} already exists. Overwrite its runtime files? [y/N]`);
  const answer = await new Promise((res) => {
    const onData = (chunk) => {
      cleanup();
      res(chunk.toString().trim());
    };
    const onEnd = () => {
      cleanup();
      res(''); // EOF: default to "no"
    };
    function cleanup() {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
    }
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
  });
  return /^y(es)?$/i.test(answer);
}

async function install() {
  if (!(await confirmOverwrite())) {
    console.log('[!] aborted: existing runtime left untouched');
    process.exit(0);
  }

  // 1. runtime -> fixed location (the package folder is deletable afterwards)
  mkdirSync(DEPLOY_DIR, { recursive: true });
  copyFileSync(join(DIR, 'hook.mjs'), HOOK_DST);
  console.log(`[+] runtime deployed -> ${DEPLOY_DIR}`);

  // 2. hooks into ~/.claude/settings.json (merge-style; foreign hooks untouched)
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    const txt = readFileSync(SETTINGS_FILE, 'utf8');
    if (!txt.includes(HOOK_PATH)) {
      const bak = `${SETTINGS_FILE}.bak.${Date.now()}`;
      copyFileSync(SETTINGS_FILE, bak);
      console.log(`[i] existing settings.json backed up -> ${bak}`);
    }
    try {
      settings = JSON.parse(txt);
    } catch {
      console.error(`[!] ${SETTINGS_FILE} is not valid JSON — fix it first, aborting`);
      process.exit(1);
    }
  }
  mergeHooks(settings);

  // 3. claude has no tty path at all: pin the session env to http unless the user
  //    set ATH_TRANSPORT explicitly (the ath-report MCP server reads the same env)
  settings.env = settings.env ?? {};
  if (!settings.env.ATH_TRANSPORT) {
    settings.env.ATH_TRANSPORT = 'http';
    console.log('[+] env.ATH_TRANSPORT=http written (claude is http-only)');
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  console.log(`[+] hooks written -> ${SETTINGS_FILE} (${EVENTS.length} events, Notification=idle_prompt, SessionEnd timeout 10s)`);

  console.log(`
Next steps:
  1. Restart any running claude sessions (hooks and env are read at startup).
  2. Optional — ath_report self-reporting: register the MCP server once,
       claude mcp add ath -- node <repo>/remote/ath-report-mcp/server.mjs
     (state-file attribution is shared with the codex bridge; no server changes).
  3. The gateway must be reachable at ATH_URL (default http://127.0.0.1:7301/event)
     from the machine claude runs on, with the ath-hud app running.`);
}

function uninstall() {
  if (existsSync(SETTINGS_FILE)) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      settings = null;
    }
    if (settings && stripHooks(settings)) {
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
      console.log(`[-] ${MARKER} hook entries removed from ${SETTINGS_FILE}`);
    } else {
      console.log(`[i] no ${MARKER} hook entries found in ${SETTINGS_FILE}`);
    }
    console.log('[i] env.ATH_TRANSPORT left in settings.json on purpose (harmless; remove by hand if unwanted)');
  }
  if (existsSync(DEPLOY_DIR)) {
    rmSync(DEPLOY_DIR, { recursive: true, force: true });
    console.log(`[-] runtime removed -> ${DEPLOY_DIR}`);
  }
  console.log('[i] left alone: ~/.codex/ath_report/ timer state (shared with the codex bridge),');
  console.log('    and any claude mcp registration (remove with: claude mcp remove ath).');
}

const cmd = process.argv.find((a) => a === 'install' || a === 'uninstall') ?? 'install';
if (cmd === 'install') await install();
else if (cmd === 'uninstall') uninstall();
else {
  console.error('usage: node install.mjs [--yes] [install|uninstall]');
  process.exit(1);
}
