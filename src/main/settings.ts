import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SettingsData } from '../shared/types';

const DEFAULTS: SettingsData = {
  warmupOnLaunch: true,
  spareRenderer: true,
  idleSocketWarming: true,
  idleWarmIntervalSec: 55,
  hardwareAcceleration: true,
  collectMetrics: true,
  restoreSession: true
};

export class Settings {
  private readonly file = path.join(app.getPath('userData'), 'settings.json');
  private data: SettingsData;

  constructor() {
    let stored: Partial<SettingsData> = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SettingsData>;
    } catch {
      // first run — defaults apply
    }
    this.data = { ...DEFAULTS, ...stored };
  }

  get(): SettingsData {
    return this.data;
  }

  set(patch: Partial<SettingsData>): SettingsData {
    this.data = { ...this.data, ...patch };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // non-fatal: settings just won't persist
    }
    return this.data;
  }
}
