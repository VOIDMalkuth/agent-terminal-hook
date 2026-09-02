#!/usr/bin/env node
// codex-hook -- Codex CLI hooks -> ath-hud bridge.
//
// Mapping:
//   SessionStart (source startup/resume/clear) -> register(waiting_input); source=compact
//     ignored (mid-turn continuation; flipping to waiting would flash a working card)
//   UserPromptSubmit -> state(working)   PreToolUse -> op(start, key=tool_use_id)
//   PostToolUse -> op(end, key=tool_use_id) (Codex has no failure event, ok is never set)
//   PermissionRequest -> state(waiting_input)   Stop -> state(waiting_input)
//   SessionEnd -> bye (3s budget: installer sets codex's cap; sendTty capped at 2.5s)
//   PreCompact/PostCompact/SubagentStart/SubagentStop -> ignored
//
// Non-blocking contract: no retries, no queueing, always exit 0. Exactly one transport,
// no fallback:
//   tty (default): ath-send (looked up on PATH) writes /dev/tty -> OSC 1337 -> WezTerm
//     gateway -> HUD. Requires a TTY for the hook process (WSL/remote SSH have one).
//     Known limitation: on Windows, codex-spawned hooks have no console and /dev/tty
//     always fails — use http on native Windows.
//   http: ATH_TRANSPORT=http POSTs straight to the gateway (no WezTerm/TTY needed).
// Every message carries title/cwd (basename(cwd)) so a HUD restart rebuilds the full
// card from the next message.
//
// Reminder injection (nudging ath_report): only SessionStart / PostToolUse write stdout.
// SessionStart injects the reporting convention and starts the timer; PostToolUse injects
// a reminder after 5 minutes without an ath_report (text demands continuing the task
// seamlessly). Both texts carry the session sid, which the model echoes back as the
// tool's sid argument for exact attribution in the MCP server. Timer state persists in
// ~/.codex/ath_report/<sess_id>.json (CODEX_HOME overridable) with sid/cwd/timers;
// entries untouched for 7 days are cleaned up.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';

const EVENT_LABEL = process.argv[2] ?? 'Unknown';
const ENDPOINT = process.env.ATH_URL ?? 'http://127.0.0.1:7301/event';
const TRANSPORT = process.env.ATH_TRANSPORT === 'http' ? 'http' : 'tty';
// ath-send is looked up on PATH (the installer copies it to ~/.local/bin); ATH_SEND overrides
const ATH_SEND = process.env.ATH_SEND ?? 'ath-send';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function compact(v) {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

function toAthMessage(label, j) {
  const sessionId = j.session_id ?? '';
  if (!sessionId) return null;
  const sid = `codex:${sessionId}`;
  const cwd = typeof j.cwd === 'string' ? j.cwd : undefined;
  const base = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    sid,
    agent: 'codex',
    cwd,
    title: cwd ? basename(cwd) : 'Codex 会话',
  };
  switch (label) {
    case 'SessionStart':
      // source=compact ignored: mid-turn continuation; waiting_input would flash a working card
      if (j.source === 'compact') return null;
      return { ...base, type: 'register', state: 'waiting_input' };
    case 'UserPromptSubmit':
      return { ...base, type: 'state', state: 'working' };
    case 'PreToolUse':
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? label,
          summary: compact(j.tool_input),
          phase: 'start',
          ...(j.tool_use_id ? { key: j.tool_use_id } : {}),
        },
      };
    case 'PostToolUse':
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? label,
          phase: 'end',
          ...(j.tool_use_id ? { key: j.tool_use_id } : {}),
        },
      };
    case 'PermissionRequest':
      return { ...base, type: 'state', state: 'waiting_input' };
    case 'Stop':
      return { ...base, type: 'state', state: 'waiting_input' };
    case 'SessionEnd':
      return { ...base, type: 'bye' };
    default:
      return null; // PreCompact/PostCompact/SubagentStart/SubagentStop: not wired
  }
}

// ---------- Reminder injection (nudging ath_report; see agents/codex/README.md) ----------
// Timer state lives in ~/.codex/ath_report/<sess_id>.json (persists across hook processes):
//   lastReportAt = when the model last called ath_report (or the session started)
//   lastRemindAt = when a reminder was last injected (same interval on repeated ignores)
const REMIND_INTERVAL_MS = 5 * 60_000;
// Both texts carry the session sid: the model echoes it back as ath_report's sid
// argument and the MCP server attributes by it (accepted only if the state file
// exists). After a compact, SessionStart re-injects, and the reminder re-anchors
// every 5 minutes, keeping the sid near the top of the model's context.
const initText = (sid) =>
  '[ath-hud] 本会话接入 ath-hud 状态屏。约定：每隔 3-5 分钟或每完成一个重要步骤，' +
  '调用 ath_report 工具简要汇报（action=当前在做什么，reason=为什么/依据，next=接下来做什么）。' +
  '汇报是旁路记录：调用后立即无缝继续原任务，不要停顿、不要等待确认、不要因此改变方向。' +
  `你的会话 sid 是 ${sid}，每次调用 ath_report 都必须在 sid 参数里原样传入它。`;
const remindText = (sid) =>
  '[ath-hud 提醒] 距上次汇报已超过 5 分钟。请现在调用一次 ath_report 工具汇报进展' +
  '（action=当前在做什么，reason=为什么/依据，next=接下来做什么）。' +
  '汇报是旁路记录：调用后立即无缝继续正在进行的任务，不要停顿、不要等待确认、不要重新规划。' +
  `你的会话 sid 是 ${sid}，调用时在 sid 参数里原样传入。`;

function statePath(sid) {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'ath_report', `${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function readState(sid) {
  try {
    return JSON.parse(readFileSync(statePath(sid), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(sid, cwd, st) {
  try {
    const dir = dirname(statePath(sid));
    mkdirSync(dir, { recursive: true });
    // Store full sid + cwd: the MCP server attributes sessions by them (sid echo check / cwd match)
    writeFileSync(statePath(sid), JSON.stringify({ ...st, sid: `codex:${sid}`, cwd }));
    // Also clean up state files untouched for 7 days
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        if (now - statSync(join(dir, f)).mtimeMs > 7 * 24 * 3_600_000) unlinkSync(join(dir, f));
      } catch {
        /* best-effort cleanup of individual files */
      }
    }
  } catch {
    /* state-file failures never affect reporting */
  }
}

// SessionStart: refresh the timer origin + inject the convention (re-injected after
// compaction so it survives context compression). PostToolUse: an ath_report arrival
// resets the timer; past the interval without one, inject the reminder.
// Returns the JSON text to print to stdout, or null for silence.
function hookReminderOutput(label, j) {
  const sid = typeof j.session_id === 'string' ? j.session_id : '';
  if (!sid) return null;
  const now = Date.now();
    const msgSid = `codex:${sid}`;
  if (label === 'SessionStart') {
    writeState(sid, j.cwd, { ...readState(sid), lastReportAt: now });
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: initText(msgSid) },
    });
  }
  if (label !== 'PostToolUse') return null;
  const st = readState(sid);
  // PostToolUse of ath_report arrived: reset the timer (tool name looks like mcp__ath__ath_report)
  if (/ath_report$/.test(j.tool_name ?? '')) {
    writeState(sid, j.cwd, { ...st, lastReportAt: now });
    return null;
  }
  const base = Math.max(st.lastReportAt ?? 0, st.lastRemindAt ?? 0);
  if (now - base < REMIND_INTERVAL_MS) return null;
  writeState(sid, j.cwd, { ...st, lastRemindAt: now });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: remindText(msgSid) },
  });
}

async function post(msg) {
  const headers = { 'content-type': 'application/json' };
  // The gateway requires a token; a missing one only affects the http exit (the tty
  // exit's token is read by the WezTerm gateway)
  let token = process.env.ATH_TOKEN;
  if (!token && process.env.APPDATA) {
    try {
      token = readFileSync(join(process.env.APPDATA, 'com.ath.hud', 'token'), 'utf8').trim();
    } catch {
      /* no token file */
    }
  }
  if (token) headers['x-ath-token'] = token;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(1500),
  });
  return res.status;
}

// On Windows /dev/tty only exists in the msys world: node cannot write it directly,
// so ath-send runs via sh. The payload goes over stdin (ath-send reads stdin when
// given no $1), sidestepping JSON command-line quoting.
function shExe() {
  if (process.platform !== 'win32') return 'sh';
  for (const p of ['C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe']) {
    if (existsSync(p)) return p;
  }
  return 'sh';
}

function sendTty(msg) {
  const r = spawnSync(shExe(), [ATH_SEND], {
    input: JSON.stringify(msg),
    // SessionEnd hook budget is 3s (codex cap); keep 500ms for stdin read + teardown so bye survives
    timeout: 2500,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (r.error) return `TTY ERR ${r.error.code ?? String(r.error).slice(0, 40)}`;
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString().trim().slice(0, 100) : '';
    return `TTY ERR exit ${r.status}${err ? ` :: ${err}` : ''}`;
  }
  return 'TTY ok';
}

const raw = await readStdin();
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {
  /* non-JSON input treated as empty object */
}
const j = parsed ?? {};

const msg = toAthMessage(EVENT_LABEL, j);
if (msg) {
  try {
    const out = TRANSPORT === 'http' ? `HTTP ${await post(msg)}` : sendTty(msg);
    if (!/^(HTTP 2|TTY ok)/.test(out)) {
      process.stderr.write(`[ath] ${EVENT_LABEL} send failed: ${out}\n`);
    }
  } catch (e) {
    process.stderr.write(`[ath] ${EVENT_LABEL} send error: ${String(e).slice(0, 80)}\n`);
  }
}

// Reminder injection: only SessionStart / PostToolUse produce stdout (JSON additionalContext);
// every other event stays silent with exit 0. Injection failures never affect reporting.
let inject = null;
try {
  inject = hookReminderOutput(EVENT_LABEL, j);
} catch {
  /* ignore */
}
if (inject) process.stdout.write(inject);

process.exit(0);
