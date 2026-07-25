// Cross-browser comparison: measures cold navigation to each retailer in
// Chrome / Edge / Brave (via CDP + puppeteer-core against YOUR installed
// binaries) and in SwiftShop (via its own bench mode). All engines report the
// same W3C Performance API metrics, so the page-load numbers are directly
// comparable. App startup time is NOT compared here — the harnesses differ.
//
// Requires: npm i -D puppeteer-core   (already in devDependencies)
// Firefox is not supported by this harness yet (see docs/ROADMAP.md).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stats, type Stats } from './report';

const ROOT = path.resolve(__dirname, '..', '..');
const POLITE_DELAY_MS = 2500;

interface NavSample {
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  dclMs: number;
  loadMs: number;
  dnsMs: number;
  tlsMs: number;
  protocol: string;
}

// Runs inside the measured page; mirrors src/preload/page.ts collection.
const COLLECT = `(() => new Promise((resolve) => {
  let lcp = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const t = e.renderTime || e.loadTime || e.startTime;
        if (t > lcp) lcp = t;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  setTimeout(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint');
    resolve(n ? {
      ttfbMs: n.responseStart,
      fcpMs: fcp ? fcp.startTime : 0,
      lcpMs: lcp,
      dclMs: n.domContentLoadedEventEnd,
      loadMs: n.loadEventEnd,
      dnsMs: n.domainLookupEnd - n.domainLookupStart,
      tlsMs: n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0,
      protocol: n.nextHopProtocol || ''
    } : null);
  }, 500);
}))()`;

function loadSites(): Record<string, string> {
  const dir = path.join(ROOT, 'config', 'retailers');
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { name: string; homepage: string };
    const key = j.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    out[key] = j.homepage;
  }
  return out;
}

async function measureWithCdp(
  executablePath: string,
  url: string
): Promise<NavSample | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshop-cmp-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: false, // headed: identical rendering conditions to real use
    defaultViewport: null,
    args: [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1360,900'
    ]
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000)); // same 3s LCP settle as SwiftShop
    return (await page.evaluate(COLLECT)) as NavSample | null;
  } catch {
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function measureSwiftShop(url: string): Promise<NavSample | null> {
  const electron = require('electron') as unknown as string;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshop-cmp-self-'));
  const outFile = path.join(profile, 'result.json');
  await new Promise<void>((resolve) => {
    const child = spawn(
      electron,
      ['.', '--bench=nav', `--url=${url}`, `--out=${outFile}`, `--profile-dir=${profile}`, '--flag-set=baseline'],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', () => {
      clearTimeout(killer);
      resolve();
    });
  });
  try {
    const r = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      visits?: Array<{ fcpMs: number; lcpMs: number; nav: Record<string, number | string> | null }>;
    };
    const v = r.visits?.[0];
    if (!v?.nav) return null;
    const n = v.nav;
    return {
      ttfbMs: Number(n.ttfbMs) || 0,
      fcpMs: v.fcpMs || 0,
      lcpMs: v.lcpMs || 0,
      dclMs: Number(n.domContentLoadedMs) || 0,
      loadMs: Number(n.loadMs) || 0,
      dnsMs: Number(n.dnsMs) || 0,
      tlsMs: Number(n.tlsMs) || 0,
      protocol: String(n.protocol ?? '')
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  try {
    require('puppeteer-core');
  } catch {
    console.error('puppeteer-core is not installed. Run: npm install');
    process.exit(1);
  }

  const iterations = Number(process.argv.includes('--iterations') ? process.argv[process.argv.indexOf('--iterations') + 1] : 3) || 3;
  const siteFilter = process.argv.includes('--sites')
    ? String(process.argv[process.argv.indexOf('--sites') + 1]).split(',')
    : null;
  const browsersCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'browsers.json'), 'utf8')) as Record<string, string>;
  const browsers: Record<string, string> = {};
  for (const [name, p] of Object.entries(browsersCfg)) {
    if (name.startsWith('$')) continue;
    if (typeof p === 'string' && fs.existsSync(p)) browsers[name] = p;
    else console.log(`skipping ${name}: not found at ${p}`);
  }

  const allSites = loadSites();
  const sites = siteFilter
    ? Object.fromEntries(Object.entries(allSites).filter(([k]) => siteFilter.includes(k)))
    : allSites;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'bench', 'results', `compare-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const results: Record<string, Record<string, Record<string, Stats>>> = {};
  const contenders = ['swiftshop', ...Object.keys(browsers)];

  for (const [site, url] of Object.entries(sites)) {
    results[site] = {};
    for (const name of contenders) {
      const samples: NavSample[] = [];
      for (let i = 0; i < iterations; i++) {
        const sample =
          name === 'swiftshop'
            ? await measureSwiftShop(url)
            : await measureWithCdp(browsers[name], url);
        if (sample) samples.push(sample);
        console.log(
          `${site} ${name} #${i + 1}: ` +
            (sample ? `TTFB ${Math.round(sample.ttfbMs)}ms LCP ${Math.round(sample.lcpMs)}ms ${sample.protocol}` : 'FAILED')
        );
        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
      }
      const byMetric: Record<string, Stats> = {};
      for (const key of ['ttfbMs', 'fcpMs', 'lcpMs', 'dclMs', 'loadMs', 'dnsMs', 'tlsMs'] as const) {
        byMetric[key] = stats(samples.map((s) => s[key]).filter((x) => x > 0));
      }
      results[site][name] = byMetric;
    }
  }

  fs.writeFileSync(path.join(dir, 'compare-summary.json'), JSON.stringify({ createdAt: new Date().toISOString(), iterations, results }, null, 2));

  const md: string[] = [
    `# Cross-browser comparison (cold navigation, fresh profile each run)`,
    ``,
    `Iterations per cell: ${iterations}. All values ms, median (p90). Same W3C Performance API metrics in every browser.`,
    `Caveats: public-internet noise; retailer bot mitigation may serve different content to different browsers; this compares page-load metrics only, not app startup.`,
    ``
  ];
  for (const [site, byBrowser] of Object.entries(results)) {
    md.push(`## ${site}`, ``, `| browser | TTFB | FCP | LCP | DCL | load |`, `|---|---|---|---|---|---|`);
    for (const [name, m] of Object.entries(byBrowser)) {
      const f = (s: Stats): string => (s.n ? `${s.median} (${s.p90})` : '—');
      md.push(`| ${name} | ${f(m.ttfbMs)} | ${f(m.fcpMs)} | ${f(m.lcpMs)} | ${f(m.dclMs)} | ${f(m.loadMs)} |`);
    }
    md.push(``);
  }
  fs.writeFileSync(path.join(dir, 'compare-report.md'), md.join('\n'));
  console.log(`\nDone. Report: ${path.join(dir, 'compare-report.md')}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
