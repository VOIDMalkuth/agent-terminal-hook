#!/usr/bin/env node
// `tauri icon` always emits the full cross-platform set; this repo's HUD is
// Windows-desktop only, so prune everything bundle.icon doesn't reference and
// the tray doesn't use, right after generation.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/hud/src-tauri/icons',
);
for (const f of [
  'icon.icns', // macOS bundle
  '64x64.png', // not referenced by tauri.conf.json bundle.icon
  '128x128@2x.png',
  'StoreLogo.png', // MSIX / store tiles
  'Square30x30Logo.png',
  'Square44x44Logo.png',
  'Square71x71Logo.png',
  'Square89x89Logo.png',
  'Square107x107Logo.png',
  'Square142x142Logo.png',
  'Square150x150Logo.png',
  'Square284x284Logo.png',
  'Square310x310Logo.png',
  'android', // mobile icon sets
  'ios',
]) {
  rmSync(join(dir, f), { recursive: true, force: true });
}
console.log('pruned unused icon derivatives (kept: bundle.icon refs + tray*.png)');
