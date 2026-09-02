import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // let the dev server read workspace sources (@ath/protocol) from the monorepo
    fs: { allow: ['..'] },
    watch: {
      // cargo/linker locks files under target/ and EBUSY-crashes the fs.watch watcher
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@ath/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
