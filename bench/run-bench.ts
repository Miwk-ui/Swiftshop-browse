// Benchmark orchestrator (runs under plain Node). Spawns the SwiftShop app in
// --bench mode across variants × iterations, aggregates statistics, writes
// summary.json + a human-readable report, and (with --tune) updates
// config/tuning.json with ONLY the optimizations that measurably won.
//
// Usage:
//   node dist/bench/run-bench.js                        # startup + nav, baseline
//   node dist/bench/run-bench.js --modes nav --sites target --iterations 5
//   node dist/bench/run-bench.js --modes dns
//   node dist/bench/run-bench.js --variants baseline,gpu-raster,no-warmup
//   node dist/bench/run-bench.js --tune                 # full A/B + write tuning.json
//   node dist/bench/run-bench.js --modes profile        # per-retailer profiling report
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateReport, stats, type Stats } from './report';

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_ROOT = path.join(ROOT, 'bench', 'results');
/** Delay between app launches — keeps load on retailer sites at polite,
 *  human-browsing levels. */
const POLITE_DELAY_MS = 2000;
const RUN_TIMEOUT_MS = 120000;

interface Variant {
  name: string;
  flagSet: string;
  warmup: 'on' | 'off';
}

interface RunResult {
  [k: string]: unknown;
  error?: string;
}

// ---------------------------------------------------------------- utilities

function electronPath(): string {
  const p = require('electron') as unknown;
  if (typeof p !== 'string') throw new Error('could not resolve electron binary path');
  return p;
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function loadSites(): Record<string, string> {
  const dir = path.join(ROOT, 'config', 'retailers');
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
      name: string;
      homepage: string;
    };
    out[slug(j.name)] = j.homepage;
  }
  return out;
}

function candidateFlagSets(): string[] {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'flags.json'), 'utf8')) as {
    sets: Record<string, unknown>;
  };
  return Object.keys(j.sets).filter((k) => k !== 'baseline');
}

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `swiftshop-${prefix}-`));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCli(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

// ------------------------------------------------------------------ runners

async function runOnce(opts: {
  mode: string;
  variant?: Variant;
  url?: string;
  repeat?: number;
  dns?: string;
  profileDir: string;
  outFile: string;
}): Promise<RunResult> {
  const args = ['.', `--bench=${opts.mode}`, `--out=${opts.outFile}`, `--profile-dir=${opts.profileDir}`];
  if (opts.url) args.push(`--url=${opts.url}`);
  if (opts.repeat && opts.repeat > 1) args.push(`--repeat=${opts.repeat}`);
  if (opts.dns) args.push(`--dns=${opts.dns}`);
  if (opts.variant) {
    args.push(`--flag-set=${opts.variant.flagSet}`);
    if (opts.variant.warmup === 'off') args.push('--warmup=off', '--spare=off');
  }
  await new Promise<void>((resolve) => {
    const child = spawn(electronPath(), args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    const killer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(killer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve();
    });
  });
  try {
    return JSON.parse(fs.readFileSync(opts.outFile, 'utf8')) as RunResult;
  } catch {
    return { error: 'no result written (crash or timeout)' };
  }
}

function startupMetrics(r: RunResult): Record<string, number> {
  const derived = (r as { timeline?: { derived?: Record<string, number | null> } }).timeline?.derived ?? {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(derived)) if (typeof v === 'number') out[k] = v;
  return out;
}

interface Visit {
  wallMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  nav?: Record<string, number | string> | null;
}

function navMetrics(r: RunResult, visitIdx = 0): { metrics: Record<string, number>; protocol: string } | null {
  const visits = (r as { visits?: Visit[] }).visits;
  const v = visits?.[visitIdx];
  if (!v || !v.nav) return null;
  const n = v.nav;
  const num = (x: unknown): number => (typeof x === 'number' && isFinite(x) ? x : 0);
  return {
    metrics: {
      ttfbMs: num(n.ttfbMs),
      fcpMs: num(v.fcpMs),
      lcpMs: num(v.lcpMs),
      dclMs: num(n.domContentLoadedMs),
      loadMs: num(n.loadMs),
      dnsMs: num(n.dnsMs),
      connectMs: num(n.connectMs),
      tlsMs: num(n.tlsMs),
      wallMs: num(v.wallMs),
      transferKb: Math.round(num(n.transferSize) / 1024)
    },
    protocol: String(n.protocol ?? '')
  };
}

// ------------------------------------------------------------- bench modes

type VariantStats = Record<string, Record<string, Stats>>;

async function benchStartup(
  variants: Variant[],
  iterations: number,
  dir: string
): Promise<{ variants: Record<string, { metrics: Record<string, Stats>; failures: number }> }> {
  const samples = new Map<string, Record<string, number>[]>();
  const failures = new Map<string, number>();
  const profiles = new Map<string, string>();
  for (const v of variants) profiles.set(v.name, freshDir(`su-${slug(v.name)}`));

  for (let i = 0; i < iterations; i++) {
    // interleave variants so ambient machine noise spreads evenly
    for (const v of variants) {
      const outFile = path.join(dir, `startup-${slug(v.name)}-${i}.json`);
      const r = await runOnce({ mode: 'startup', variant: v, profileDir: profiles.get(v.name)!, outFile });
      const m = startupMetrics(r);
      if (r.error || !Object.keys(m).length) failures.set(v.name, (failures.get(v.name) ?? 0) + 1);
      else samples.set(v.name, [...(samples.get(v.name) ?? []), m]);
      process.stdout.write(`  startup ${v.name} #${i + 1}: ${m.processToShown ?? '?'}ms to window\n`);
      await delay(500);
    }
  }
  const out: Record<string, { metrics: Record<string, Stats>; failures: number }> = {};
  for (const v of variants) {
    out[v.name] = { metrics: collate(samples.get(v.name) ?? []), failures: failures.get(v.name) ?? 0 };
  }
  return { variants: out };
}

async function benchNav(
  variants: Variant[],
  sites: Record<string, string>,
  iterations: number,
  dir: string
): Promise<Record<string, Record<string, { cold: Record<string, Stats>; warm: Record<string, Stats>; repeat: Record<string, Stats>; protocols: Record<string, number>; failures: number }>>> {
  const out: Record<string, Record<string, { cold: Record<string, Stats>; warm: Record<string, Stats>; repeat: Record<string, Stats>; protocols: Record<string, number>; failures: number }>> = {};
  for (const [site, url] of Object.entries(sites)) {
    out[site] = {};
    for (const v of variants) {
      const cold: Record<string, number>[] = [];
      const warm: Record<string, number>[] = [];
      const repeat: Record<string, number>[] = [];
      const protocols: Record<string, number> = {};
      let failures = 0;
      const warmProfile = freshDir(`nav-${site}-${slug(v.name)}`);

      // run 0: fresh profile = cold (empty caches). runs 1..N: warm profile.
      for (let i = 0; i <= iterations; i++) {
        const isCold = i === 0;
        const outFile = path.join(dir, `nav-${site}-${slug(v.name)}-${i}.json`);
        const r = await runOnce({
          mode: 'nav',
          variant: v,
          url,
          repeat: 2,
          profileDir: isCold ? warmProfile : warmProfile,
          outFile
        });
        const first = navMetrics(r, 0);
        const second = navMetrics(r, 1);
        if (!first) {
          failures++;
        } else {
          (isCold ? cold : warm).push(first.metrics);
          if (first.protocol) protocols[first.protocol] = (protocols[first.protocol] ?? 0) + 1;
          if (second && !isCold) repeat.push(second.metrics);
        }
        process.stdout.write(
          `  nav ${site} ${v.name} ${isCold ? 'cold' : `warm#${i}`}: ` +
            (first ? `TTFB ${Math.round(first.metrics.ttfbMs)}ms LCP ${Math.round(first.metrics.lcpMs)}ms ${first.protocol}` : 'FAILED') +
            '\n'
        );
        await delay(POLITE_DELAY_MS);
      }
      out[site][v.name] = {
        cold: collate(cold),
        warm: collate(warm),
        repeat: collate(repeat),
        protocols,
        failures
      };
    }
  }
  return out;
}

async function benchDns(
  providers: string[],
  iterations: number,
  dir: string
): Promise<Record<string, { firstPassMs: Stats; cachedPassMs: Stats; failures: number }>> {
  const out: Record<string, { firstPassMs: Stats; cachedPassMs: Stats; failures: number }> = {};
  for (const provider of providers) {
    const first: number[] = [];
    const cached: number[] = [];
    let failures = 0;
    for (let i = 0; i < iterations; i++) {
      const outFile = path.join(dir, `dns-${provider}-${i}.json`);
      const r = await runOnce({
        mode: 'dns',
        dns: provider,
        profileDir: freshDir(`dns-${provider}`),
        outFile
      });
      const runs = (r as { runs?: { host: string; pass: number; ms: number; error?: string }[] }).runs;
      if (!runs) {
        failures++;
        continue;
      }
      for (const run of runs) {
        if (run.error) continue;
        (run.pass === 0 ? first : cached).push(run.ms);
      }
      process.stdout.write(`  dns ${provider} #${i + 1}: median first-pass ${stats(first).median}ms\n`);
      await delay(700);
    }
    out[provider] = { firstPassMs: stats(first), cachedPassMs: stats(cached), failures };
  }
  return out;
}

async function benchProfile(dir: string): Promise<RunResult> {
  const outFile = path.join(dir, 'profile.json');
  // warm shared profile so the profile reflects a real user's repeat visit
  return runOnce({ mode: 'profile', profileDir: path.join(os.tmpdir(), 'swiftshop-profilemode'), outFile });
}

function collate(samples: Record<string, number>[]): Record<string, Stats> {
  const keys = new Set(samples.flatMap((s) => Object.keys(s)));
  const out: Record<string, Stats> = {};
  for (const k of keys) {
    out[k] = stats(samples.map((s) => s[k]).filter((x): x is number => typeof x === 'number'));
  }
  return out;
}

// ------------------------------------------------------------------- tuner

interface Summary {
  createdAt: string;
  host: Record<string, unknown>;
  args: Record<string, unknown>;
  sections: Record<string, unknown>;
}

/** A candidate wins only with a >=5% median improvement on the primary metric
 *  AND no >5% regression on startup. DNS providers must beat system by >=10ms
 *  median. Marginal results stay disabled — the noise floor of public-internet
 *  benchmarks is real. */
function decideTuning(summary: Summary): {
  enabledSets: string[];
  dns: string | null;
  warmup: boolean;
  evidence: Record<string, unknown>;
} {
  const evidence: Record<string, unknown> = {};
  const enabledSets: string[] = [];
  const nav = summary.sections.nav as
    | Record<string, Record<string, { warm: Record<string, Stats> }>>
    | undefined;
  const startup = summary.sections.startup as
    | { variants: Record<string, { metrics: Record<string, Stats> }> }
    | undefined;

  const primary = (v: { warm: Record<string, Stats> }): number | null => {
    const lcp = v.warm.lcpMs?.median;
    const load = v.warm.loadMs?.median;
    if (lcp && lcp > 0) return lcp;
    if (load && load > 0) return load;
    return null;
  };

  const variantNames = new Set<string>();
  if (nav) for (const site of Object.values(nav)) for (const v of Object.keys(site)) variantNames.add(v);

  for (const name of variantNames) {
    if (name === 'baseline' || name === 'no-warmup') continue;
    const deltas: number[] = [];
    if (nav) {
      for (const site of Object.values(nav)) {
        const base = site['baseline'] ? primary(site['baseline']) : null;
        const cand = site[name] ? primary(site[name]) : null;
        if (base && cand && base > 0) deltas.push((cand - base) / base);
      }
    }
    const avgDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;

    let startupRegression = 0;
    const baseShown = startup?.variants['baseline']?.metrics.processToShown?.median;
    const candShown = startup?.variants[name]?.metrics.processToShown?.median;
    if (baseShown && candShown) startupRegression = (candShown - baseShown) / baseShown;

    const win = avgDelta !== null && avgDelta <= -0.05 && startupRegression <= 0.05;
    evidence[name] = { avgNavDelta: avgDelta, startupDelta: startupRegression, enabled: win, sampleSites: deltas.length };
    if (win) enabledSets.push(name);
  }

  // warmup: disable only if turning it OFF was >=5% faster (it hurt)
  let warmup = true;
  if (nav) {
    const deltas: number[] = [];
    for (const site of Object.values(nav)) {
      const base = site['baseline'] ? primary(site['baseline']) : null;
      const noWarm = site['no-warmup'] ? primary(site['no-warmup']) : null;
      if (base && noWarm && base > 0) deltas.push((noWarm - base) / base);
    }
    if (deltas.length) {
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      warmup = !(avg <= -0.05);
      evidence['warmup'] = { avgDeltaWhenDisabled: avg, keepWarmup: warmup };
    }
  }

  // dns: pick fastest first-pass median if it beats system by >=10ms
  let dns: string | null = null;
  const dnsSec = summary.sections.dns as Record<string, { firstPassMs: Stats }> | undefined;
  if (dnsSec && dnsSec['system']) {
    const sysMedian = dnsSec['system'].firstPassMs.median;
    let best: { name: string; median: number } | null = null;
    for (const [name, v] of Object.entries(dnsSec)) {
      if (name === 'system') continue;
      if (best === null || v.firstPassMs.median < best.median) best = { name, median: v.firstPassMs.median };
    }
    if (best && sysMedian - best.median >= 10) dns = best.name;
    evidence['dns'] = { systemMedianMs: sysMedian, best, chosen: dns };
  }

  return { enabledSets, dns, warmup, evidence };
}

// ----------------------------------------------------------------- profile analysis

function analyzeProfile(r: RunResult): string[] {
  const recs: string[] = [];
  const pages = (r as {
    pages?: { retailer: string; metrics: { nav?: Record<string, number> | null; resources?: { topHosts: { host: string; count: number }[]; cacheHits: number; sizedCount: number } } }[];
  }).pages;
  if (!pages) return ['Profile run failed — no page data collected.'];
  for (const p of pages) {
    const nav = p.metrics.nav;
    const res = p.metrics.resources;
    if (!nav) {
      recs.push(`${p.retailer}: page did not produce metrics (possible bot challenge or timeout).`);
      continue;
    }
    if (nav.dnsMs > 50) recs.push(`${p.retailer}: DNS took ${Math.round(nav.dnsMs)}ms — verify launch warmup covers this host, and run \`npm run bench:dns\` to test DoH providers.`);
    if (nav.tlsMs > 120) recs.push(`${p.retailer}: TLS handshake ${Math.round(nav.tlsMs)}ms — preconnect at launch should hide this; confirm the origin is in the retailer profile.`);
    if (res && res.sizedCount > 10) {
      const hitRate = res.cacheHits / res.sizedCount;
      if (hitRate < 0.5) recs.push(`${p.retailer}: repeat-visit cache hit rate only ${(hitRate * 100).toFixed(0)}% of size-visible resources — consider testing the big-cache flag set (\`npm run tune\`).`);
    }
    if (res) {
      const known = new Set<string>();
      for (const f of fs.readdirSync(path.join(ROOT, 'config', 'retailers'))) {
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'retailers', f), 'utf8')) as { dnsHosts: string[] };
        for (const h of j.dnsHosts) known.add(h);
      }
      const missing = res.topHosts.filter((h) => h.count >= 5 && h.host && !known.has(h.host));
      for (const m of missing.slice(0, 5)) {
        recs.push(`${p.retailer}: host ${m.host} served ${m.count} resources but is not in any retailer profile — add it to dnsHosts/preconnectOrigins and re-benchmark.`);
      }
    }
  }
  if (!recs.length) recs.push('No obvious bottlenecks detected in this profile run.');
  return recs;
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const tune = Boolean(cli['tune']);
  const iterations = Number(cli['iterations'] ?? (tune ? 5 : 5)) || 5;
  const allSites = loadSites();
  const siteFilter = typeof cli['sites'] === 'string' ? String(cli['sites']).split(',') : null;
  const sites = siteFilter
    ? Object.fromEntries(Object.entries(allSites).filter(([k]) => siteFilter.includes(k)))
    : allSites;
  if (typeof cli['url'] === 'string') sites['custom'] = String(cli['url']);

  const modes = tune
    ? ['startup', 'nav', 'dns']
    : typeof cli['modes'] === 'string'
      ? String(cli['modes']).split(',')
      : ['startup', 'nav'];

  let variants: Variant[];
  if (typeof cli['variants'] === 'string') {
    variants = String(cli['variants'])
      .split(',')
      .map((name) =>
        name === 'no-warmup'
          ? { name, flagSet: 'baseline', warmup: 'off' as const }
          : { name, flagSet: name, warmup: 'on' as const }
      );
  } else if (tune) {
    variants = [
      { name: 'baseline', flagSet: 'baseline', warmup: 'on' },
      { name: 'no-warmup', flagSet: 'baseline', warmup: 'off' },
      ...candidateFlagSets().map((s) => ({ name: s, flagSet: s, warmup: 'on' as const }))
    ];
  } else {
    variants = [{ name: 'baseline', flagSet: 'baseline', warmup: 'on' }];
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RESULTS_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`SwiftShop bench → ${dir}`);
  console.log(`modes=${modes.join(',')} variants=${variants.map((v) => v.name).join(',')} iterations=${iterations}`);
  console.log(`sites: ${Object.entries(sites).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const sections: Record<string, unknown> = {};

  if (modes.includes('startup')) {
    console.log('\n== startup ==');
    sections.startup = await benchStartup(variants, iterations, dir);
  }
  if (modes.includes('nav')) {
    console.log('\n== navigation ==');
    sections.nav = await benchNav(variants, sites, iterations, dir);
  }
  if (modes.includes('dns')) {
    console.log('\n== dns providers ==');
    sections.dns = await benchDns(['system', 'cloudflare', 'google'], Math.min(iterations, 3), dir);
  }
  if (modes.includes('profile')) {
    console.log('\n== profile ==');
    const r = await benchProfile(dir);
    const recommendations = analyzeProfile(r);
    sections.profile = { recommendations };
    const recFile = path.join(dir, 'recommendations.md');
    fs.writeFileSync(recFile, `# Profiler recommendations\n\n${recommendations.map((x) => `- ${x}`).join('\n')}\n`);
    console.log(recommendations.map((x) => `  • ${x}`).join('\n'));
  }

  const summary: Summary = {
    createdAt: new Date().toISOString(),
    host: {
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memGb: Math.round(os.totalmem() / 1e9)
    },
    args: { modes, iterations, sites, variants: variants.map((v) => v.name) },
    sections
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

  if (tune) {
    const decision = decideTuning(summary);
    const tuningFile = path.join(ROOT, 'config', 'tuning.json');
    const tuning = {
      $doc: 'Written by `npm run tune` — see evidence for the measurements behind each decision.',
      enabledSets: decision.enabledSets,
      dns: decision.dns,
      warmup: decision.warmup,
      evidence: { ...decision.evidence, benchmarkDir: dir, decidedAt: new Date().toISOString() }
    };
    fs.writeFileSync(tuningFile, JSON.stringify(tuning, null, 2));
    console.log(`\nTuning decision written to config/tuning.json:`);
    console.log(`  enabledSets: [${decision.enabledSets.join(', ') || 'none — baseline won'}]`);
    console.log(`  dns: ${decision.dns ?? 'system'}   warmup: ${decision.warmup}`);
  }

  generateReport(dir);
  console.log(`\nDone. Report: ${path.join(dir, 'report.md')}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
