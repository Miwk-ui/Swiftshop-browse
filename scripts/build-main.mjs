// Bundles the Electron main process, preloads, and the Node-based bench tools.
// esbuild keeps builds sub-second; 'electron' and 'puppeteer-core' stay external
// (electron is provided by the runtime, puppeteer-core is optional).
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info'
};

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
  external: ['electron']
});

await build({
  ...common,
  entryPoints: ['src/preload/chrome.ts'],
  outfile: 'dist/preload/chrome.cjs',
  external: ['electron']
});

await build({
  ...common,
  entryPoints: ['src/preload/page.ts'],
  outfile: 'dist/preload/page.cjs',
  external: ['electron']
});

await build({
  ...common,
  entryPoints: ['bench/run-bench.ts', 'bench/report-cli.ts', 'bench/compare-browsers.ts'],
  outdir: 'dist/bench',
  external: ['electron', 'puppeteer-core']
});

await build({
  ...common,
  entryPoints: ['tests/unit.test.ts'],
  outdir: 'dist/tests',
  external: ['electron']
});
