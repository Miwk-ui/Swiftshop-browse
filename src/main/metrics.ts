import { EventEmitter } from 'node:events';
import type { PageMetrics, StartupSnapshot, WarmupResult } from '../shared/types';

/** Wall-clock timeline of startup phases. First write wins per mark so
 *  accidental double-marks can't skew measurements. */
class Timeline {
  readonly marks: Record<string, number> = {};
  warmup: WarmupResult[] | null = null;

  constructor() {
    const proc = process as NodeJS.Process & { getCreationTime?: () => number | null };
    const created = proc.getCreationTime?.();
    if (typeof created === 'number') this.marks['processStart'] = created;
  }

  mark(name: string, at: number = Date.now()): void {
    if (!(name in this.marks)) this.marks[name] = at;
  }

  snapshot(): StartupSnapshot {
    const m = this.marks;
    const rel = (a: string, b: string): number | null =>
      m[a] !== undefined && m[b] !== undefined ? m[b]! - m[a]! : null;
    return {
      marks: { ...m },
      derived: {
        processToMain: rel('processStart', 'mainStart'),
        mainToReady: rel('mainStart', 'appReady'),
        readyToWindowCreated: rel('appReady', 'windowCreated'),
        windowToShown: rel('windowCreated', 'windowShown'),
        shownToUiLoaded: rel('windowShown', 'uiLoaded'),
        processToShown: rel('processStart', 'windowShown'),
        processToUiLoaded: rel('processStart', 'uiLoaded'),
        warmupMs: rel('warmupStart', 'warmupDone')
      }
    };
  }

  async waitForMark(name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(name in this.marks)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for mark ${name}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export const timeline = new Timeline();

/** Routes page metrics (from page preloads) to whoever is listening —
 *  the bench controller, the UI stats chip, and the metrics log. */
class MetricsHub extends EventEmitter {
  emitNav(wcId: number, payload: PageMetrics): void {
    this.emit('nav', wcId, payload);
  }

  waitForNav(wcId: number, timeoutMs: number): Promise<PageMetrics> {
    return new Promise((resolve, reject) => {
      const handler = (id: number, p: PageMetrics): void => {
        if (id === wcId && p.phase === 'settled' && p.url !== 'about:blank') {
          cleanup();
          resolve(p);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout waiting for page metrics'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('nav', handler);
      };
      this.on('nav', handler);
    });
  }
}

export const hub = new MetricsHub();
