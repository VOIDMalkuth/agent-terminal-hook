// Test collector on 127.0.0.1:7399: receives ATH messages from bridge scripts
// and appends them to tmp/codex-events.jsonl (arrival time + source port).
// Never touches the real gateway/HUD; answers 204.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tmp', 'codex-events.jsonl');
const PORT = 7399;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
    res.writeHead(204).end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[collector] listening http://127.0.0.1:${PORT}/event → ${OUT}`);
});
