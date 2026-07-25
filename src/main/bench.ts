import { app, type Session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliArgs } from './args';
import { hub, timeline } from './metrics';
import type { TabManager } from './tabs';
import type { PageMetrics, RetailerProfile } from '../shared/types';

/**
 * In-app benchmark controller. When the app is launched with --bench=<mode>,
 * it runs one measurement scenario, writes a JSON result to --out, and exits.
 * The Node-side orchestrator (bench/run-bench.ts) spawns many of these across
 * variants and iterations and aggregates statistics.
 *
 * Modes:
 *   startup  — measure process→ready→window-shown→UI-loaded phases, exit.
 *   nav      — open a tab, navigate to --url, wait for Performance API
 *              metrics (TTFB/FCP/LCP/DCL/load + connection breakdown).
 *              --repeat=N navigates N times to also measure warm repeats.
 *   profile  — visit each retailer homepage once, collect per-page metrics
 *              plus resource host summaries for preconnect recommendations.
 *   dns      — resolve every configured host with the active DNS config
 *              (--dns=system|cloudflare|google), twice each (cold-ish, cached).
 */
export class BenchController {
  constructor(
    private readonly args: CliArgs,
    private readonly tabs: TabManager,
    private readonly appliedFlags: [string, string][],
    private readonly retailers: RetailerProfile[]
  ) {}

  async run(): Promise<void> {
    const mode = this.args.bench;
    try {
      if (mode === 'startup') await this.runStartup();
      else if (mode === 'nav') await this.runNav();
      else if (mode === 'profile') await this.runProfile();
      else throw new Error(`unknown bench mode: ${mode}`);
    } catch (err) {
      this.write({ kind: mode, error: String(err) });
      app.exit(0);
    }
  }

  private async runStartup(): Promise<void> {
    await timeline.waitForMark('uiLoaded', 20000);
    // small settle so late marks (warmup) can land
    await delay(700);
    this.write({ kind: 'startup' });
    app.exit(0);
  }

  private async runNav(): Promise<void> {
    const url = this.args.url;
    if (!url) throw new Error('--url required for nav bench');
    const repeat = Math.max(1, Number(this.args.repeat ?? '1') || 1);
    const id = this.tabs.newTab();
    const wcId = this.tabs.webContentsId(id);
    const visits: Array<PageMetrics & { wallMs: number }> = [];
    for (let i = 0; i < repeat; i++) {
      const t0 = Date.now();
      timeline.mark(i === 0 ? 'navStart' : `navStart${i}`);
      this.tabs.navigateTab(id, url);
      const payload = await hub.waitForNav(wcId, 60000);
      visits.push({ ...payload, wallMs: Date.now() - t0 });
      if (i < repeat - 1) await delay(1500);
    }
    this.write({ kind: 'nav', url, visits });
    app.exit(0);
  }

  private async runProfile(): Promise<void> {
    const pages: Array<{ retailer: string; metrics: PageMetrics & { wallMs: number } }> = [];
    const id = this.tabs.newTab();
    const wcId = this.tabs.webContentsId(id);
    for (const r of this.retailers) {
      const t0 = Date.now();
      this.tabs.navigateTab(id, r.homepage);
      try {
        const payload = await hub.waitForNav(wcId, 60000);
        pages.push({ retailer: r.name, metrics: { ...payload, wallMs: Date.now() - t0 } });
      } catch (err) {
        pages.push({
          retailer: r.name,
          metrics: { wallMs: Date.now() - t0, error: String(err) } as never
        });
      }
      await delay(2000);
    }
    this.write({ kind: 'profile', pages });
    app.exit(0);
  }

  static async runDnsBench(
    ses: Session,
    retailers: RetailerProfile[],
    args: CliArgs
  ): Promise<void> {
    const hosts = [...new Set(retailers.flatMap((r) => r.dnsHosts))];
    const runs: Array<{ host: string; pass: number; ms: number; error?: string }> = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const host of hosts) {
        const t0 = Date.now();
        try {
          await ses.resolveHost(host);
          runs.push({ host, pass, ms: Date.now() - t0 });
        } catch (err) {
          runs.push({ host, pass, ms: Date.now() - t0, error: String(err) });
        }
      }
    }
    const out = {
      kind: 'dns',
      meta: baseMeta(args, []),
      dnsProvider: args.dns ?? 'system',
      runs
    };
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    }
    app.exit(0);
  }

  private write(extra: Record<string, unknown>): void {
    const result = {
      meta: baseMeta(this.args, this.appliedFlags),
      timeline: timeline.snapshot(),
      warmup: timeline.warmup,
      appMetrics: safeAppMetrics(),
      ...extra
    };
    if (this.args.out) {
      fs.mkdirSync(path.dirname(this.args.out), { recursive: true });
      fs.writeFileSync(this.args.out, JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
}

function baseMeta(args: CliArgs, flags: [string, string][]): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    flagSet: args.flagSet ?? '(tuned default)',
    appliedFlags: flags,
    warmup: args.warmup !== 'off',
    spare: args.spare !== 'off',
    dns: args.dns ?? 'system',
    profileDir: args.profileDir ?? '(default)',
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  };
}

function safeAppMetrics(): unknown {
  try {
    return app.getAppMetrics().map((m) => ({
      type: m.type,
      cpuPercent: m.cpu?.percentCPUUsage,
      workingSetKb: m.memory?.workingSetSize
    }));
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
