#!/usr/bin/env node
// mock-send -- external test/demo script: plays a remote agent, POSTing ATH v1
// events to the ath-hud local gateway. The HUD is a pure receiver; in the real
// pipeline these POSTs come from the WezTerm Lua gateway, which this script stands
// in for (message shapes match packages/protocol, the schema source of truth).
//
// Usage:
//   node scripts/mock-send.mjs                 # one ~35s four-session scenario
//   node scripts/mock-send.mjs --loop          # keep replaying
//   node scripts/mock-send.mjs --speed 3       # 3x speed
//   node scripts/mock-send.mjs --token XXX --url http://127.0.0.1:7301/event
//
// Token defaults to %APPDATA%\com.ath.hud\token, or the ATH_TOKEN env var.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const url = opt('--url', 'http://127.0.0.1:7301/event');
const loop = has('--loop');
const speed = Math.max(0.1, Number(opt('--speed', '1')) || 1);

const token = (() => {
  const t = opt('--token', null) ?? process.env.ATH_TOKEN;
  if (t) return t;
  try {
    return readFileSync(join(process.env.APPDATA ?? '', 'com.ath.hud', 'token'), 'utf8').trim();
  } catch {
    console.error('找不到 token：先启动 ath-hud（首启自动生成），或传 --token XXX / 设 ATH_TOKEN');
    process.exit(1);
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One scenario pass: four sessions plus a "reconnect" session without register,
 * covering every message type: register / state / report / bye, op start-end
 * pairing (key), failure close (ok:false). `at` is ms at speed=1. sids are
 * regenerated each cycle so cards never collide with the previous round.
 */
function buildScenario(sidA, sidB, sidC, sidD) {
  // Reference sender behavior: identity fields (title/cwd/agent/host) on every
  // message — a HUD restart rebuilds the full card from the first arrival
  const mk = (meta, fields) => ({ v: 1, ts: Math.floor(Date.now() / 1000), ...meta, ...fields });
  const A = { sid: sidA, agent: 'claude', host: 'mock-box', cwd: '~/work/api-server', title: '重构登录模块' };
  const B = { sid: sidB, agent: 'codex', host: 'mock-box', cwd: '~/work/refactools', title: '抽取 CLI 参数解析' };
  const C = { sid: sidC, agent: 'omp', host: 'mock-box', cwd: '~/work/docs-gen', title: '生成 API 文档' };
  const D = { sid: sidD, agent: 'claude', host: 'mock-box', cwd: '~/work/api-server', title: '重构登录模块' };
  return [
    // -- A: register -> paired op (start/end) -> report -> paired op --
    { at: 0, msg: mk(A, { type: 'register', state: 'waiting_input' }) },
    { at: 600, msg: mk(A, { type: 'state', state: 'working' }) },
    { at: 900, msg: mk(A, { type: 'op', op: { tool: 'Edit', summary: 'src/auth.rs:120', phase: 'start', key: 'e1' } }) },
    { at: 2400, msg: mk(A, { type: 'op', op: { tool: 'Edit', summary: 'src/auth.rs:120', phase: 'end', key: 'e1' } }) },
    { at: 3000, msg: mk(A, { type: 'report', report: { summary: '重构登录权限校验', reason: 'token 校验遗漏过期分支', next: '修完跑全量测试' } }) },
    { at: 4200, msg: mk(A, { type: 'op', op: { tool: 'Bash', summary: 'cargo test -q', phase: 'start', key: 'e2' } }) },
    { at: 5600, msg: mk(A, { type: 'op', op: { tool: 'Bash', summary: 'cargo test -q', phase: 'end', key: 'e2' } }) },
    { at: 7000, msg: mk(A, { type: 'state', state: 'waiting_input' }) }, // awaiting approval

    // -- B joins mid-run: read file -> waiting --
    { at: 8200, msg: mk(B, { type: 'register', state: 'waiting_input' }) },
    { at: 9200, msg: mk(B, { type: 'state', state: 'working' }) },
    { at: 9600, msg: mk(B, { type: 'op', op: { tool: 'Read', summary: 'src/main.rs', phase: 'start', key: 'r1' } }) },
    { at: 10800, msg: mk(B, { type: 'op', op: { tool: 'Read', summary: 'src/main.rs', phase: 'end', key: 'r1' } }) },
    { at: 12200, msg: mk(A, { type: 'state', state: 'working' }) }, // A: approved, resumes work
    { at: 13400, msg: mk(A, { type: 'op', op: { tool: 'Edit', summary: 'src/auth.rs:201', phase: 'start', key: 'e3' } }) },
    { at: 14800, msg: mk(A, { type: 'op', op: { tool: 'Edit', summary: 'src/auth.rs:201', phase: 'end', key: 'e3' } }) },
    { at: 16200, msg: mk(B, { type: 'state', state: 'waiting_input' }) },

    // -- C short-lived: finishes and says bye --
    { at: 17600, msg: mk(C, { type: 'register', state: 'waiting_input' }) },
    { at: 18400, msg: mk(C, { type: 'state', state: 'working' }) },
    { at: 18800, msg: mk(C, { type: 'op', op: { tool: 'Grep', summary: 'docs/**/*.md', phase: 'start', key: 'c1' } }) },
    { at: 19900, msg: mk(C, { type: 'op', op: { tool: 'Grep', summary: 'docs/**/*.md', phase: 'end', key: 'c1' } }) },
    { at: 21400, msg: mk(C, { type: 'report', report: { summary: 'API 文档已生成', reason: '接口注释与实现已对齐', next: '无需后续' } }) },
    { at: 22800, msg: mk(C, { type: 'bye' }) },

    // -- B: one failed Bash (ok:false -> ✗) + report --
    { at: 23600, msg: mk(B, { type: 'state', state: 'working' }) },
    { at: 24000, msg: mk(B, { type: 'op', op: { tool: 'Bash', summary: 'npm test', phase: 'start', key: 'r2' } }) },
    { at: 26400, msg: mk(B, { type: 'op', op: { tool: 'Bash', summary: 'npm test', phase: 'end', key: 'r2', ok: false } }) },
    { at: 27800, msg: mk(B, { type: 'report', report: { summary: '参数解析抽到独立模块', reason: 'main.rs 过长，先拆再测', next: '修复失败用例后补集成测试' } }) },
    { at: 29000, msg: mk(B, { type: 'state', state: 'waiting_input' }) },

    // -- D: op without register (simulates a lost first message / HUD reconnect) --
    { at: 29600, msg: mk(D, { type: 'op', op: { tool: 'Bash', summary: 'git rebase --continue', phase: 'start', key: 'd1' } }) },
    { at: 31200, msg: mk(D, { type: 'op', op: { tool: 'Bash', summary: 'git rebase --continue', phase: 'end', key: 'd1' } }) },
    { at: 32600, msg: mk(D, { type: 'state', state: 'waiting_input' }) },

    // -- closing: A finishes its last test round and says bye --
    { at: 33600, msg: mk(A, { type: 'op', op: { tool: 'Bash', summary: 'cargo test --all', phase: 'start', key: 'e4' } }) },
    { at: 35800, msg: mk(A, { type: 'op', op: { tool: 'Bash', summary: 'cargo test --all', phase: 'end', key: 'e4' } }) },
    { at: 37200, msg: mk(A, { type: 'report', report: { summary: '过期分支已补齐并通过全量测试', reason: '补时钟回拨边界用例', next: '无需后续' } }) },
    { at: 38600, msg: mk(A, { type: 'bye' }) },
    { at: 40000, msg: mk(B, { type: 'bye' }) },
  ];
}

async function send(msg) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ath-token': token },
    body: JSON.stringify(msg),
  });
  const tag = msg.op ? ` ${msg.op.tool}` : msg.state ? ` ${msg.state}` : msg.action ? ` ${msg.action}` : '';
  if (!res.ok) {
    console.error(`[mock] HTTP ${res.status}: ${await res.text()}`);
  } else {
    const sidShort = msg.sid.split(':')[0];
    console.log(`[mock] -> ${sidShort.padEnd(6)} ${msg.type}${tag}`);
  }
}

async function runCycle(cycle) {
  // fresh uuids each cycle (equivalent of the CLI hook stdin session_id in the real pipeline)
  const sidA = `claude:${crypto.randomUUID()}`;
  const sidB = `codex:${crypto.randomUUID()}`;
  const sidC = `omp:${crypto.randomUUID()}`;
  const sidD = `claude:${crypto.randomUUID()}`;
  const steps = buildScenario(sidA, sidB, sidC, sidD);
  const t0 = Date.now();
  for (const st of steps) {
    const wait = t0 + st.at / speed - Date.now();
    if (wait > 0) await sleep(wait);
    await send(st.msg);
  }
  console.log(`[mock] 第 ${cycle} 轮完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

console.log(`[mock] POST ${url}  speed=${speed}x${loop ? '  loop=∞' : ''}`);
let n = 1;
await runCycle(n);
if (loop) {
  for (;;) {
    await sleep(6000 / speed);
    await runCycle(++n);
  }
}
console.log('[mock] done');
