// One-shot probe: after the window settles, emit a full session flow
// (register -> op start -> op end -> Stop), each encoded like ath-send:
// base64(JSON) wrapped in an OSC 1337 SetUserVar.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgs = [
  { v: 1, type: 'register', sid: 'probe:osc-gw', agent: 'zcode', title: 'OSC探针(可删)', state: 'waiting_input' },
  { v: 1, type: 'op', sid: 'probe:osc-gw', op: { tool: 'Bash', summary: 'probe op', phase: 'start', key: 'k1' } },
  { v: 1, type: 'op', sid: 'probe:osc-gw', op: { tool: 'Bash', phase: 'end', key: 'k1' } },
  { v: 1, type: 'state', sid: 'probe:osc-gw', state: 'waiting_input' },
];

await sleep(1500); // stay clear of the measured ~1s window-startup race
mkdirSync(join(REPO, 'tmp'), { recursive: true });
for (const m of msgs) {
  const json = JSON.stringify({ ...m, ts: Math.floor(Date.now() / 1000) });
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  process.stdout.write(`\x1b]1337;SetUserVar=ATH=${b64}\x07`);
  writeFileSync(join(REPO, 'tmp', 'gw-debug.log'), `EMIT ${json}\n`, { flag: 'a' });
  await sleep(300);
}
await sleep(1500);
process.exit(0);
