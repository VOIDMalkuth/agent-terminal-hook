#!/usr/bin/env node
// ath-report-mcp -- MCP stdio server exposing the ath_report tool so the model can
// self-report to ath-hud (design.md §6). Shared across agents (codex, claude, ...):
// whichever agent registers it, the report card follows the sid's agent prefix.
//
// Flow: the agent CLI spawns this process (stdio = MCP JSON-RPC, reserved by the
// protocol — debug prints go to stderr only) -> tools/call(ath_report) -> ATH v1
// report message -> remote/ath-send writes /dev/tty (same exit as codex-hook; needs
// a TTY, WSL/SSH have one; ATH_TRANSPORT=http forces direct HTTP) -> OSC 1337 ->
// WezTerm gateway -> the card's self-description.
//
// Session attribution (most to least trusted; resolved once per process — one MCP
// server per session):
//   1. sid echoed by the model (from the hook-injected prompt), accepted only if its
//      state file exists (guards against hallucinated sids creating ghost cards)
//   2. newest state file whose cwd matches this process's cwd (separates concurrent sessions)
//   3. globally newest state file (fallback)
//   4. no state at all -> standalone codex:mcp-<pid> card
//
// Protocol: hand-written MCP stdio (newline-delimited JSON-RPC 2.0), zero deps —
// remote deployment only needs node.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// ath-send pinned to the in-repo absolute path (the /mnt/c/... form under WSL); no PATH lookup
const ATH_SEND = process.env.ATH_SEND ?? join(REPO, 'remote', 'ath-send');
const ENDPOINT = process.env.ATH_URL ?? 'http://127.0.0.1:7301/event';
const TRANSPORT = process.env.ATH_TRANSPORT === 'http' ? 'http' : 'tty';

const TOOL = {
  name: 'ath_report',
  description:
    '向 ath-hud 状态屏汇报当前工作进展（旁路记录，不打断工作流程）。' +
    '每完成一个重要步骤或每隔 3-5 分钟调用一次：action=当前在做什么，' +
    'reason=为什么做/依据是什么，next=接下来打算做什么。' +
    '调用后请立即继续当前任务，不要停顿、不要等待确认、不要因此改变工作方向。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '当前在做什么（简短一句话）' },
      reason: { type: 'string', description: '为什么做/依据是什么（可选）' },
      next: { type: 'string', description: '接下来打算做什么（可选）' },
      sid: {
        type: 'string',
        description: '会话 ID：系统注入提示里给出的本会话 sid，每次调用原样传入',
      },
    },
    required: ['action'],
  },
};

// ---------- Transport (same semantics as agents/codex/hook.mjs) ----------

function shExe() {
  if (process.platform !== 'win32') return 'sh';
  for (const p of ['C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe']) {
    if (existsSync(p)) return p;
  }
  return 'sh';
}

function sendTty(msg) {
  // `sh <file>` opens a script by path and never searches PATH; route through
  // `exec "$1"` so an ATH_SEND override with a bare name resolves too
  const r = spawnSync(shExe(), ['-c', 'exec "$1"', 'ath-send-runner', ATH_SEND], {
    input: JSON.stringify(msg),
    timeout: 3000,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (r.error) return `TTY ERR ${r.error.code ?? String(r.error).slice(0, 40)}`;
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString().trim().slice(0, 100) : '';
    return `TTY ERR exit ${r.status}${err ? ` :: ${err}` : ''}`;
  }
  return 'TTY ok';
}

async function postHttp(msg) {
  const headers = { 'content-type': 'application/json' };
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
  return `HTTP ${res.status}`;
}

// ---------- Session attribution & message assembly ----------

let stickySid = null;

function resolveSid(preferred) {
  if (stickySid) return stickySid;
  const dir = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'ath_report');
  const entries = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        entries.push({
          f,
          m: statSync(join(dir, f)).mtimeMs,
          st: JSON.parse(readFileSync(join(dir, f), 'utf8')),
        });
      } catch {
        /* skip unreadable individual files */
      }
    }
  } catch {
    /* state dir missing (hook not deployed) -> fall through */
  }
  // The hook sanitizes filenames to [a-zA-Z0-9_-]; legacy files lack the sid field,
  // so reverse-apply the sanitize rule
  const sidOf = (e) => e.st.sid ?? e.f.replace(/\.json$/, '').replace(/^codex_/, 'codex:');
  // 1. model-echoed sid: accept only if well-formed and the state file really exists,
  //    otherwise treat as a hallucination and fall through to the heuristics
  const want = typeof preferred === 'string' ? preferred.trim() : '';
  if (/^[\w:-]{1,128}$/.test(want)) {
    const wantFile = `${want.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    if (entries.some((e) => e.f === wantFile)) return (stickySid = want);
  }
  // 2/3. cwd match first (separates concurrent sessions), newest mtime within a rank;
  //      then globally newest mtime
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const rank = (e) => (e.st.cwd && norm(e.st.cwd) === norm(process.cwd()) ? 1 : 0);
  entries.sort((a, b) => rank(b) - rank(a) || b.m - a.m);
  return (stickySid = entries[0] ? sidOf(entries[0]) : `codex:mcp-${process.pid}`);
}

async function forwardReport(args) {
  const cwd = process.cwd();
  const sid = resolveSid(args.sid);
  // the sid prefix names the owning agent (claude:<uuid> / codex:<uuid> / ...); the
  // server is shared across agents, so the card chip must not be hardcoded
  const agent = /^[a-z]+:/.test(sid) ? sid.slice(0, sid.indexOf(':')) : 'codex';
  const msg = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    sid,
    agent,
    cwd,
    title: cwd ? basename(cwd) : `${agent} 会话`,
    type: 'report',
    report: {
      summary: String(args.action ?? '').slice(0, 200),
      ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}),
      ...(args.next ? { next: String(args.next).slice(0, 300) } : {}),
    },
  };
  const out =
    TRANSPORT === 'http' ? await postHttp(msg) : sendTty(msg);
  process.stderr.write(`[ath] report forwarded: ${out}\n`);
  return out;
}

// ---------- MCP stdio (newline-delimited JSON-RPC 2.0) ----------

async function dispatch(m) {
  switch (m.method) {
    case 'initialize':
      return {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ath-report', version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (m.params?.name !== TOOL.name) {
        return {
          content: [{ type: 'text', text: `未知工具：${m.params?.name}` }],
          isError: true,
        };
      }
      try {
        // a failed forward must not error to the model — reporting is a best-effort
        // side channel; never let it retry or get distracted
        const r = await forwardReport(m.params?.arguments ?? {});
        return { content: [{ type: 'text', text: `已上报 ath-hud（${r}）。请继续当前任务。` }] };
      } catch (e) {
        process.stderr.write(`[ath] forward failed: ${String(e).slice(0, 120)}\n`);
        return { content: [{ type: 'text', text: '已记录。请继续当前任务。' }] };
      }
    }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return; // ignore non-JSON lines
  }
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
  if (m.id === undefined || m.id === null) return; // notification: never answered
  let result;
  let error;
  try {
    result = await dispatch(m);
  } catch (e) {
    error = { code: e.code ?? -32603, message: String(e.message ?? e).slice(0, 120) };
  }
  const resp = error
    ? { jsonrpc: '2.0', id: m.id, error }
    : { jsonrpc: '2.0', id: m.id, result };
  process.stdout.write(JSON.stringify(resp) + '\n');
}
