#!/usr/bin/env node
// Collect the release exe into dist/ under a versioned name; the version's
// single source of truth is apps/hud/src-tauri/tauri.conf.json.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(
  readFileSync(join(ROOT, 'apps/hud/src-tauri/tauri.conf.json'), 'utf8'),
).version;
const OUT_DIR = join(ROOT, 'dist');
const dst = join(OUT_DIR, `ath-hud-${VERSION}.exe`);

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(join(ROOT, 'apps/hud/src-tauri/target/release/ath-hud.exe'), dst);
console.log(`wrote dist/ath-hud-${VERSION}.exe`);
