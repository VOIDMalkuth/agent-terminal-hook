#!/usr/bin/env node
// claude-hook -- Claude Code hooks -> ath-hud gateway bridge (http transport).
//
// Claude Code hooks run without a controlling terminal on every platform (there is
// no /dev/tty to write) and the terminalSequence escape hatch whitelists OSC
// 0/1/2/9/99/777 but rejects OSC 1337, so the codex bridge's ath-send/tty path does
// not exist here. Events are mapped and POSTed straight to the local gateway
// (ATH_URL, default http://127.0.0.1:7301/event). The mapping is transport-agnostic:
// an OSC 2 (window-title) carrier — the hook emits ATH1:-prefixed titles via
// terminalSequence, the WezTerm gateway sniffs them in format-tab-title and renders
// the original title — slots in as an alternative last mile without touching it.
//
// Mapping (the event name is read from stdin's hook_event_name, argv[2] fallback):
//   SessionStart (startup/resume/clear/fork) -> register(waiting_input); source=compact
//     ignored (mid-turn continuation; flipping to waiting would flash a working card)
//   UserPromptSubmit -> state(working)   PreToolUse -> op(start, key=tool_use_id, input)
//   PostToolUse -> op(end, key=tool_use_id)
//   PostToolUseFailure -> op(end, ok=false) (cancelling a running tool fires no hook,
//     so is_interrupt is not a dependable signal)
//   PermissionRequest -> review (claude fires it only when actually prompting the user
//     — an unambiguous human-approval mark, unlike codex; its input carries no
//     tool_use_id, review.key stays optional)
//   PermissionDenied -> op(end, ok=false) (denied calls fire PreToolUse but no Post*
//     event; without this the running-op spinner would hang forever)
//   Stop -> state(waiting_input) (not fired when the user interrupts)
//   StopFailure -> state(waiting_input) (turn ended by an API error)
//   Notification(idle_prompt) -> state(waiting_input) (~60s-delayed fallback: an
//     interrupt fires no hook at all, this eventually un-sticks the green card)
//   SessionEnd -> bye (default 1.5s shared budget; the installed hook entry sets
//     timeout: 10 so the bye reliably fits)
//   everything else (Setup / subagents / tasks / model-switch / elicitation / ...)
//   is ignored; subagent tool events carry the same session_id and fold into the
//   session's op stream, which is the desired display.
//
// Non-blocking contract: no retries, no queueing, always exit 0 — a hook must never
// drag the session down.
//
// ath_report reminder injection (nudging the reporting MCP): only SessionStart /
// PostToolUse write stdout. Same scheme as the codex bridge; the state file lives in
// the same directory the ath-report MCP server reads (CODEX_HOME ?? ~/.codex), so
// the server accepts claude sids without any change on its side.

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

// op.input payload cap: raw tool args for the HUD's receiver-side display rules
// (lib/opFormat.ts); over budget degrade to truncated JSON text (a string input
// displays verbatim). HTTP loopback — the cap only bounds message size.
const INPUT_MAX_BYTES = 1200;
function rawInput(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.length <= INPUT_MAX_BYTES ? v : compact(v);
  if (typeof v !== 'object') return undefined;
  try {
    return JSON.stringify(v).length <= INPUT_MAX_BYTES ? v : compact(v);
  } catch {
    return undefined;
  }
}

function toAthMessage(j) {
  const label = j.hook_event_name ?? process.argv[2] ?? 'Unknown';
  const sessionId = j.session_id ?? '';
  if (!sessionId) return null;
  const sid = `claude:${sessionId}`;
  const cwd = typeof j.cwd === 'string' ? j.cwd : undefined;
  const base = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    sid,
    agent: 'claude',
    cwd,
    title: cwd ? basename(cwd) : 'Claude 会话',
  };
  switch (label) {
    case 'SessionStart':
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
          input: rawInput(j.tool_input),
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
    case 'PostToolUseFailure':
      // the failure text only shows when the matching start never arrived (HUD
      // reconnected mid-run); paired ends keep the start's display
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? label,
          input: j.error ? `失败: ${compact(j.error)}` : undefined,
          phase: 'end',
          ok: false,
          ...(j.tool_use_id ? { key: j.tool_use_id } : {}),
        },
      };
    case 'PermissionRequest':
      return { ...base, type: 'review', review: { tool: j.tool_name ?? 'approval' } };
    case 'PermissionDenied':
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? label,
          phase: 'end',
          ok: false,
          ...(j.tool_use_id ? { key: j.tool_use_id } : {}),
        },
      };
    case 'Stop':
    case 'StopFailure':
      return { ...base, type: 'state', state: 'waiting_input' };
    case 'Notification':
      if (j.notification_type !== 'idle_prompt') return null;
      return { ...base, type: 'state', state: 'waiting_input' };
    case 'SessionEnd':
      return { ...base, type: 'bye' };
    default:
      return null;
  }
}

// ---------- Reminder injection (nudging ath_report; see agents/codex/hook.mjs) ----------
const REMIND_INTERVAL_MS = 5 * 60_000;
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
  // deliberately the same directory the ath-report MCP server reads
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
    // store the full ATH sid: the MCP server matches the model-echoed claude:<uuid> against it
    writeFileSync(statePath(sid), JSON.stringify({ ...st, sid: `claude:${sid}`, cwd }));
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
// compaction). PostToolUse: an ath_report arrival resets the timer; past the interval
// without one, inject the reminder. Returns the JSON text for stdout, or null.
function hookReminderOutput(label, j) {
  const sid = typeof j.session_id === 'string' ? j.session_id : '';
  if (!sid) return null;
  const msgSid = `claude:${sid}`;
  const now = Date.now();
  if (label === 'SessionStart') {
    writeState(sid, j.cwd, { ...readState(sid), lastReportAt: now });
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: initText(msgSid) },
    });
  }
  if (label !== 'PostToolUse') return null;
  const st = readState(sid);
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
  let token = process.env.ATH_TOKEN;
  if (!token && process.env.APPDATA) {
    try {
      token = readFileSync(join(process.env.APPDATA, 'com.ath.hud', 'token'), 'utf8').trim();
    } catch {
      /* no token file */
    }
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-ath-token'] = token;
  const res = await fetch(process.env.ATH_URL ?? 'http://127.0.0.1:7301/event', {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(1500),
  });
  return res.status;
}

const raw = await readStdin();
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {
  /* non-JSON input treated as empty object */
}
const j = parsed ?? {};
const label = j.hook_event_name ?? process.argv[2] ?? 'Unknown';

const msg = toAthMessage(j);
if (msg) {
  try {
    const status = await post(msg);
    if (status >= 300) {
      process.stderr.write(`[ath] ${label} send failed: HTTP ${status}\n`);
    }
  } catch (e) {
    process.stderr.write(`[ath] ${label} send error: ${String(e).slice(0, 80)}\n`);
  }
}

// Reminder injection: only SessionStart / PostToolUse produce stdout (JSON
// additionalContext); every other event stays silent with exit 0. Stdout must contain
// ONLY the JSON object — send failures above go to stderr, never stdout.
let inject = null;
try {
  inject = hookReminderOutput(label, j);
} catch {
  /* ignore */
}
if (inject) process.stdout.write(inject);

process.exit(0);
