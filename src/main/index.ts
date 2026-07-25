// SwiftShop main entry. Startup ordering is deliberate and measured:
//   1. (sync, pre-ready) parse args → set profile dir → apply Chromium flags
//   2. app ready → show window ASAP (nothing network-related blocks this)
//   3. after the window is visible: DNS warmup + preconnect + spare renderer
// Every phase is timestamped in the timeline so `npm run bench:startup`
// can attribute time to each step.
const tMainStart = Date.now();

import { BrowserWindow, Menu, app, session } from 'electron';
import * as path from 'node:path';
import { parseArgs } from './args';
import { BenchController } from './bench';
import { startApiServer } from './api-server';
import { Bookmarks } from './bookmarks';
import { PARTITION, loadFlagSets, loadRetailers, loadTuning } from './config';
import { setupDownloads } from './downloads';
import { applyFlags } from './flags';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { timeline } from './metrics';
import { Settings } from './settings';
import { CHROME_HEIGHT, TabManager } from './tabs';
import { preconnectAll, startIdleWarming, warmDns } from './warmup';

timeline.mark('mainStart', tMainStart);

const args = parseArgs(process.argv.slice(1));
if (args.profileDir) app.setPath('userData', path.resolve(args.profileDir));

const flagSets = loadFlagSets();
const tuning = loadTuning();
const appliedFlags = applyFlags(flagSets, tuning, args.flagSet);

const settings = new Settings();
if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();

// Single-instance: a second launch focuses the warm, already-running window
// instead of paying full process startup again. Skipped in bench mode where
// many short-lived instances with isolated profiles are spawned on purpose.
if (!args.bench) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

let win: BrowserWindow | null = null;
let tabs: TabManager | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#15171a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'chrome.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  timeline.mark('windowCreated');
  win.once('ready-to-show', () => {
    if (!args.hidden) win?.show();
    timeline.mark('windowShown');
  });
  win.webContents.once('did-finish-load', () => timeline.mark('uiLoaded'));
  tabs = new TabManager(win, settings);
  win.on('resize', () => tabs?.layout());
  win.on('close', () => tabs?.saveSession());
  win.on('closed', () => {
    win = null;
  });
}

function configureDns(provider: string): void {
  const configs: Record<string, Electron.ConfigureHostResolverOptions> = {
    system: { secureDnsMode: 'off' },
    cloudflare: { secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] },
    google: { secureDnsMode: 'secure', secureDnsServers: ['https://dns.google/dns-query'] }
  };
  const cfg = configs[provider];
  if (cfg) {
    try {
      app.configureHostResolver(cfg);
    } catch (err) {
      console.error('configureHostResolver failed:', err);
    }
  }
}

function hardenSession(ses: Electron.Session): void {
  // Present a standard Chrome UA (matching our actual Chromium build) instead
  // of Electron's default. Retailer sites vary served content on UA; the
  // Electron token can trigger degraded or blocked experiences. This is the
  // same Chromium engine, honestly versioned — see docs/OPTIMIZATIONS.md.
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  ses.setUserAgent(ua);
  // Deny permission prompts by default: no notification/geolocation popups,
  // and fewer background subsystems spun up per page.
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
}

app.whenReady().then(async () => {
  timeline.mark('appReady');

  const dnsProvider = args.dns ?? tuning.dns ?? undefined;
  if (dnsProvider) configureDns(dnsProvider);

  const ses = session.fromPartition(PARTITION);
  hardenSession(ses);
  const retailers = loadRetailers();
  const bookmarks = new Bookmarks(retailers);

  // DNS bench needs no window at all
  if (args.bench === 'dns') {
    await BenchController.runDnsBench(ses, retailers, args);
    return;
  }

  createWindow();
  const downloads = setupDownloads(ses, () => win);
  // IPC must be live before the UI loads — the chrome calls ui:init on boot.
  registerIpc({
    tabs: tabs!,
    bookmarks,
    settings,
    retailers,
    downloads,
    ses,
    appliedFlags,
    getWin: () => win
  });
  Menu.setApplicationMenu(buildMenu(() => tabs, () => win));
  try {
    await win!.loadFile(path.join(app.getAppPath(), 'dist', 'ui', 'index.html'));
  } catch (err) {
    // Retry once — transient profile/cache contention (e.g. AV scan or a second
    // process racing on the disk cache) can fail the first load.
    console.error('UI load failed, retrying:', err);
    await new Promise((r) => setTimeout(r, 250));
    await win!.loadFile(path.join(app.getAppPath(), 'dist', 'ui', 'index.html'));
  }

  startApiServer(tabs!);

  const s = settings.get();
  const warmupEnabled = args.warmup !== 'off' && s.warmupOnLaunch && tuning.warmup;
  if (warmupEnabled) {
    // Deferred to the next tick so warmup never delays first paint of the UI.
    setTimeout(() => {
      timeline.mark('warmupStart');
      void warmDns(ses, retailers).then((results) => {
        preconnectAll(ses, retailers);
        timeline.mark('warmupDone');
        timeline.warmup = results;
      });
    }, 0);
    if (s.idleSocketWarming && !args.bench) {
      startIdleWarming(ses, retailers, s.idleWarmIntervalSec);
    }
  }
  if (s.spareRenderer && args.spare !== 'off') {
    setTimeout(() => tabs?.ensureSpare(), 2500);
  }

  if (args.bench) {
    void new BenchController(args, tabs!, appliedFlags, retailers).run();
  } else {
    const restored = tabs!.restoreSession();
    if (!restored) tabs!.newTab();
  }
});

app.on('window-all-closed', () => app.quit());

export { CHROME_HEIGHT };
