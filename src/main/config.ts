import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FlagsFile, RetailerProfile, Tuning } from '../shared/types';

/** Single persistent partition: cookies, HTTP cache, IndexedDB, service workers
 *  and localStorage all survive restarts, so logins and caches stay warm. */
export const PARTITION = 'persist:swiftshop';

const ROOT = app.getAppPath();

export function loadJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T;
}

export function loadRetailers(): RetailerProfile[] {
  const dir = path.join(ROOT, 'config', 'retailers');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RetailerProfile);
}

export function loadFlagSets(): FlagsFile {
  return loadJson<FlagsFile>('config/flags.json');
}

export function loadTuning(): Tuning {
  try {
    const t = loadJson<Partial<Tuning>>('config/tuning.json');
    return {
      enabledSets: t.enabledSets ?? [],
      dns: t.dns ?? null,
      warmup: t.warmup !== false,
      evidence: t.evidence ?? {}
    };
  } catch {
    return { enabledSets: [], dns: null, warmup: true, evidence: {} };
  }
}
