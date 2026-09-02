#!/usr/bin/env node
// Package the agent-side files for standalone deployment: exactly what
// agents/codex/install.mjs references through its own relative paths, laid out
// identically to the repo so the installer works straight from the archive.
// Outputs into dist/ (version's single source: apps/hud/src-tauri/tauri.conf.json):
//   ath-agent-<version>.tar.gz — unpack anywhere, then inside it run
//     `node agents/codex/install.mjs` (Linux/WSL; then trust the hooks via /hooks)
//   ath-gateway-<version>.lua — standalone copy of the WezTerm gateway (configured
//     by hand on the Windows side, so it ships next to the archive, not inside it)
// Deliberately excluded from the archive: docs, HUD side.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(
  readFileSync(join(ROOT, 'apps/hud/src-tauri/tauri.conf.json'), 'utf8'),
).version;
const OUT_DIR = join(ROOT, 'dist');
// relative path on purpose: GNU tar reads a leading `C:` as a remote hostname
const OUT_REL = `dist/ath-agent-${VERSION}.tar.gz`;
const FILES = [
  'agents/codex/install.mjs',
  'agents/codex/hook.mjs',
  'remote/ath-send',
  'remote/ath-report-mcp/server.mjs',
];

for (const f of FILES) statSync(join(ROOT, f)); // throws if a piece is missing

mkdirSync(OUT_DIR, { recursive: true });
rmSync(join(OUT_DIR, `ath-agent-${VERSION}.tar.gz`), { force: true });
const r = spawnSync('tar', ['-czf', OUT_REL, ...FILES], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) {
  console.error('packaging failed: `tar` (bsdtar on Windows 10+, GNU tar elsewhere) is required');
  process.exit(1);
}
// gateway Lua next to the archive, not inside it
copyFileSync(
  join(ROOT, 'gateway/wezterm/ath-gateway.lua'),
  join(OUT_DIR, `ath-gateway-${VERSION}.lua`),
);
console.log(`wrote ${OUT_REL} (${FILES.length} files) + dist/ath-gateway-${VERSION}.lua`);
