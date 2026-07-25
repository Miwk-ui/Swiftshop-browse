import { defineConfig } from 'vite';

// Builds only the browser chrome UI (tab strip / toolbar). The Electron main
// process and preloads are bundled separately by scripts/build-main.mjs so the
// UI bundle stays tiny and framework-free.
export default defineConfig({
  root: 'src/ui',
  base: './',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    target: 'chrome120',
    minify: true,
    modulePreload: false
  }
});
