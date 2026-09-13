#!/usr/bin/env node
// zcode-hook -- ZCode hooks -> ath-hud local gateway bridge.
// ZCode runs on this Windows machine, so hooks can POST 127.0.0.1:7301 directly;
// no OSC/WezTerm needed.
//
// Behavior:
//   1. Best-effort mapping of ZCode events to ATH v1 messages:
//      SessionStart->register(waiting_input)  UserPromptSubmit->working
//      PreToolUse->op(start)  PostToolUse/PostToolUseFailure->op(end, paired by toolCallId)
//      (ZCode has no SessionEnd, hence no bye; sessions end via stale or manual delete.
//       Known blind spot measured 2026-08-30: background compaction emits no hook events —
//       since register defaults to waiting_input, the card rests at "waiting", never stuck working.)
//   2. Non-blocking contract: loopback await fetch (normally ms; immediate connect
//      error when the HUD is down), no retries, no queueing, always exit 0 —
//      a hook must never drag the session down.
// Event name arrives via the config's args (argv[2]).

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const EVENT_LABEL = process.argv[2] ?? 'Unknown';
const ENDPOINT = process.env.ATH_URL ?? 'http://127.0.0.1:7301/event';

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

// op.input payload: raw tool args for the HUD's receiver-side display rules
// (lib/opFormat.ts); over budget degrade to truncated JSON text (a string input
// displays verbatim). Loopback POST — the cap only bounds message size.
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

// Pre/Post pairing key: ZCode carries toolCallId on both sides (measured via dump);
// fall back to a few common spellings
function pairKey(j) {
  const k = j.toolCallId ?? j.tool_use_id ?? j.tool_call_id ?? j.toolUseId;
  return typeof k === 'string' && k ? k : undefined;
}

// ZCode stdin field names verified experimentally (hook-dump.jsonl); defensive extraction
function toAthMessage(label, j) {
  const sessionId = j.session_id ?? j.sessionId ?? '';
  const sid = `zcode:${sessionId || 'unknown'}`;
  const cwd = typeof j.cwd === 'string' ? j.cwd : undefined;
  // Attach title/cwd to every message: after a HUD restart the first message
  // rebuilds the full card (avoids a bare-sid title)
  const base = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    sid,
    agent: 'zcode',
    cwd,
    title: cwd ? basename(cwd) : 'ZCode 会话',
  };
  switch (label) {
    case 'SessionStart':
      // A new task registers as waiting_input: at registration the agent is necessarily
      // waiting for the user's first message
      // (source: startup/resume/clear/compact all handled; title/cwd already in base)
      return { ...base, type: 'register', state: 'waiting_input' };
    case 'UserPromptSubmit':
      return { ...base, type: 'state', state: 'working' };
    case 'PreToolUse':
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? j.toolName ?? j.tool ?? label,
          input: rawInput(j.tool_input ?? j.input),
          phase: 'start',
          ...(pairKey(j) ? { key: pairKey(j) } : {}),
        },
      };
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = label === 'PostToolUseFailure';
      return {
        ...base,
        type: 'op',
        op: {
          tool: j.tool_name ?? j.toolName ?? j.tool ?? label,
          // when paired, the HUD keeps the start's display; this input only shows if
          // the start never arrived. Failure event field names not yet measured — cover a few
          input: failed
            ? `失败: ${compact(j.error ?? j.errorMessage ?? j.error_message ?? j.tool_response)}`
            : rawInput(j.tool_input ?? j.input),
          phase: 'end',
          ...(failed ? { ok: false } : {}),
          ...(pairKey(j) ? { key: pairKey(j) } : {}),
        },
      };
    }
    case 'PermissionRequest':
      return { ...base, type: 'state', state: 'waiting_input' };
    case 'Stop':
      return { ...base, type: 'state', state: 'waiting_input' }; // turn ended = waiting for input
    default:
      return null;
  }
}

async function post(msg) {
  let token = process.env.ATH_TOKEN;
  if (!token) {
    token = readFileSync(join(process.env.APPDATA ?? '', 'com.ath.hud', 'token'), 'utf8').trim();
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ath-token': token },
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

if (toAthMessage(EVENT_LABEL, j)) {
  try {
    const status = await post(toAthMessage(EVENT_LABEL, j));
    if (status >= 300) {
      process.stderr.write(`[ath] ${EVENT_LABEL} send failed: HTTP ${status}\n`);
    }
  } catch (e) {
    process.stderr.write(`[ath] ${EVENT_LABEL} send error: ${String(e).slice(0, 80)}\n`);
  }
}

process.exit(0);
