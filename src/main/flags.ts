import { app } from 'electron';
import type { FlagsFile, Tuning } from '../shared/types';

/**
 * Applies Chromium switches BEFORE app ready. Sources, in priority order:
 *  1. --flag-set=<name,name...> CLI override (used by the benchmark harness)
 *  2. tuning.enabledSets (sets that won their A/B benchmark on this machine)
 * Returns the applied [switch, value] pairs so bench output can record exactly
 * what configuration produced each measurement.
 */
export function applyFlags(sets: FlagsFile, tuning: Tuning, override?: string): [string, string][] {
  const names = override !== undefined
    ? override.split(',').map((s) => s.trim()).filter((s) => s && s !== 'baseline')
    : tuning.enabledSets;
  const applied: [string, string][] = [];
  for (const name of names) {
    const set = sets.sets[name];
    if (!set) continue;
    for (const sw of set.switches) {
      const [key, value] = sw;
      if (value !== undefined) app.commandLine.appendSwitch(key, value);
      else app.commandLine.appendSwitch(key);
      applied.push([key, value ?? '']);
    }
  }
  return applied;
}
