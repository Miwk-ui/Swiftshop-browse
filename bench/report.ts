// Report generator: turns a bench results directory (summary.json) into
// report.md (tables) and report.html (self-contained, inline-SVG charts —
// zero chart dependencies).
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Stats {
  n: number;
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
  stdev: number;
}

export function stats(values: number[]): Stats {
  if (!values.length) return { n: 0, mean: 0, median: 0, p90: 0, min: 0, max: 0, stdev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const r = (x: number): number => Math.round(x * 10) / 10;
  return {
    n: values.length,
    mean: r(mean),
    median: r(q(0.5)),
    p90: r(q(0.9)),
    min: r(sorted[0]),
    max: r(sorted[sorted.length - 1]),
    stdev: r(Math.sqrt(variance))
  };
}

type StatMap = Record<string, Stats>;

interface Summary {
  createdAt: string;
  host: Record<string, unknown>;
  args: Record<string, unknown>;
  sections: {
    startup?: { variants: Record<string, { metrics: StatMap; failures: number }> };
    nav?: Record<
      string,
      Record<
        string,
        { cold: StatMap; warm: StatMap; repeat: StatMap; protocols: Record<string, number>; failures: number }
      >
    >;
    dns?: Record<string, { firstPassMs: Stats; cachedPassMs: Stats; failures: number }>;
    profile?: { recommendations: string[] };
  };
}

const fmt = (s: Stats | undefined): string =>
  !s || s.n === 0 ? '—' : `${s.median} (p90 ${s.p90}, n=${s.n})`;

export function generateReport(dir: string): void {
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as Summary;
  const md: string[] = [];
  md.push(`# SwiftShop benchmark report`);
  md.push(``);
  md.push(`- Generated: ${summary.createdAt}`);
  md.push(`- Host: ${JSON.stringify(summary.host)}`);
  md.push(`- Config: ${JSON.stringify(summary.args)}`);
  md.push(``);
  md.push(
    `> All values are milliseconds, reported as median (p90, sample count). ` +
      `Public-internet numbers are noisy — treat differences under ~5% as noise. ` +
      `Retailer bot mitigation may serve challenge pages; metrics measure whatever the server actually sent.`
  );

  const s = summary.sections;
  if (s.startup) {
    md.push(``, `## Startup`, ``);
    const metricNames = ['processToShown', 'processToUiLoaded', 'mainToReady', 'windowToShown', 'warmupMs'];
    md.push(`| variant | ${metricNames.join(' | ')} | failures |`);
    md.push(`|---|${metricNames.map(() => '---').join('|')}|---|`);
    for (const [name, v] of Object.entries(s.startup.variants)) {
      md.push(`| ${name} | ${metricNames.map((m) => fmt(v.metrics[m])).join(' | ')} | ${v.failures} |`);
    }
  }

  if (s.nav) {
    for (const [site, variants] of Object.entries(s.nav)) {
      md.push(``, `## Navigation — ${site}`, ``);
      const cols = ['ttfbMs', 'fcpMs', 'lcpMs', 'dclMs', 'loadMs', 'dnsMs', 'tlsMs'];
      for (const phase of ['cold', 'warm', 'repeat'] as const) {
        md.push(``, `### ${phase === 'cold' ? 'Cold (empty profile)' : phase === 'warm' ? 'Warm (populated cache, fresh process)' : 'Repeat (2nd visit, same session)'}`, ``);
        md.push(`| variant | ${cols.join(' | ')} | protocol |`);
        md.push(`|---|${cols.map(() => '---').join('|')}|---|`);
        for (const [name, v] of Object.entries(variants)) {
          const proto = Object.entries(v.protocols)
            .map(([p, c]) => `${p}×${c}`)
            .join(' ');
          md.push(`| ${name} | ${cols.map((c) => fmt(v[phase][c])).join(' | ')} | ${proto} |`);
        }
      }
    }
  }

  if (s.dns) {
    md.push(``, `## DNS providers`, ``);
    md.push(`| provider | first resolve (per host) | cached resolve | failures |`);
    md.push(`|---|---|---|---|`);
    for (const [name, v] of Object.entries(s.dns)) {
      md.push(`| ${name} | ${fmt(v.firstPassMs)} | ${fmt(v.cachedPassMs)} | ${v.failures} |`);
    }
    md.push(``, `> "first resolve" still benefits from the OS DNS cache for the system provider; DoH providers bypass it. Interpret alongside real navigation numbers.`);
  }

  if (s.profile) {
    md.push(``, `## Profiler recommendations`, ``);
    for (const r of s.profile.recommendations) md.push(`- ${r}`);
  }

  fs.writeFileSync(path.join(dir, 'report.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'report.html'), buildHtml(summary));
}

function bar(label: string, value: number, max: number, color: string): string {
  const w = max > 0 ? Math.max(1, Math.round((value / max) * 420)) : 1;
  return (
    `<div class="row"><span class="lbl">${esc(label)}</span>` +
    `<svg width="470" height="18"><rect x="0" y="2" width="${w}" height="14" fill="${color}" rx="3"/>` +
    `<text x="${w + 6}" y="14" font-size="11" fill="#555">${value}ms</text></svg></div>`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function buildHtml(summary: Summary): string {
  const parts: string[] = [];
  parts.push(
    `<!doctype html><meta charset="utf-8"><title>SwiftShop benchmark</title><style>` +
      `body{font:13px system-ui;margin:24px;max-width:760px}h2{margin-top:28px}` +
      `.row{display:flex;align-items:center;gap:8px;margin:2px 0}.lbl{width:200px;text-align:right;color:#333;font-size:12px}` +
      `.note{color:#777;font-size:12px}</style>`
  );
  parts.push(`<h1>SwiftShop benchmark</h1><p class="note">${esc(summary.createdAt)} — ${esc(JSON.stringify(summary.host))}</p>`);
  const palette = ['#4da3ff', '#ffa94d', '#69db7c', '#ff6b6b', '#b197fc', '#63e6be'];

  const su = summary.sections.startup;
  if (su) {
    parts.push(`<h2>Startup — process start → window shown (median)</h2>`);
    const entries = Object.entries(su.variants)
      .map(([name, v]) => [name, v.metrics['processToShown']?.median ?? 0] as [string, number])
      .filter(([, v]) => v > 0);
    const max = Math.max(...entries.map(([, v]) => v), 1);
    entries.forEach(([name, v], i) => parts.push(bar(name, v, max, palette[i % palette.length])));
  }

  const nav = summary.sections.nav;
  if (nav) {
    for (const [site, variants] of Object.entries(nav)) {
      for (const metric of ['ttfbMs', 'lcpMs'] as const) {
        parts.push(`<h2>${esc(site)} — warm ${metric === 'ttfbMs' ? 'TTFB' : 'LCP'} (median)</h2>`);
        const entries = Object.entries(variants)
          .map(([name, v]) => [name, v.warm[metric]?.median ?? 0] as [string, number])
          .filter(([, v]) => v > 0);
        if (!entries.length) {
          parts.push(`<p class="note">no successful samples</p>`);
          continue;
        }
        const max = Math.max(...entries.map(([, v]) => v), 1);
        entries.forEach(([name, v], i) => parts.push(bar(name, v, max, palette[i % palette.length])));
      }
    }
  }

  const dns = summary.sections.dns;
  if (dns) {
    parts.push(`<h2>DNS — first resolve median</h2>`);
    const entries = Object.entries(dns).map(
      ([name, v]) => [name, v.firstPassMs.median] as [string, number]
    );
    const max = Math.max(...entries.map(([, v]) => v), 1);
    entries.forEach(([name, v], i) => parts.push(bar(name, v, max, palette[i % palette.length])));
  }

  parts.push(
    `<p class="note">Medians over small samples on the public internet. Differences under ~5% are noise. See report.md for full tables.</p>`
  );
  return parts.join('\n');
}

/** Newest results dir containing a summary.json, or '' if none. */
export function newestResultsDir(): string {
  const root = path.resolve(__dirname, '..', '..', 'bench', 'results');
  const dirs = fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.existsSync(path.join(d, 'summary.json')))
    .sort();
  return dirs[dirs.length - 1] ?? '';
}
