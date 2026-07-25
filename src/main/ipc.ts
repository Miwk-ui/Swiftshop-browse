import { ipcMain, type BrowserWindow, type Session } from 'electron';
import type { Bookmarks } from './bookmarks';
import type { DownloadsHandle } from './downloads';
import { hub, timeline } from './metrics';
import type { Settings } from './settings';
import type { TabManager } from './tabs';
import { preconnectOrigin } from './warmup';
import type { PageMetrics, RetailerProfile } from '../shared/types';

export interface IpcDeps {
  tabs: TabManager;
  bookmarks: Bookmarks;
  settings: Settings;
  retailers: RetailerProfile[];
  downloads: DownloadsHandle;
  ses: Session;
  appliedFlags: [string, string][];
  getWin: () => BrowserWindow | null;
}

export function registerIpc(d: IpcDeps): void {
  // --- tabs / navigation ---
  ipcMain.on('tabs:new', (_e, url?: string) => d.tabs.newTab(url));
  ipcMain.on('tabs:activate', (_e, id: number) => d.tabs.activate(id));
  ipcMain.on('tabs:close', (_e, id: number) => d.tabs.close(id));
  ipcMain.on('nav:go', (_e, url: string) => d.tabs.navigate(url));
  ipcMain.on('nav:back', () => d.tabs.back());
  ipcMain.on('nav:forward', () => d.tabs.forward());
  ipcMain.on('nav:reload', () => d.tabs.reload());
  ipcMain.on('nav:stop', () => d.tabs.stop());
  ipcMain.handle('tabs:state', () => d.tabs.state());

  // --- chrome UI panel resizing (page view shrinks while a panel is open) ---
  ipcMain.on('chrome:panel', (_e, open: boolean) => d.tabs.setPanel(open));

  // --- speculative warming (e.g. hovering a retailer chip) ---
  ipcMain.on('warm:origin', (_e, origin: string) => {
    if (typeof origin === 'string' && origin.startsWith('https://')) {
      preconnectOrigin(d.ses, origin);
    }
  });

  // --- bookmarks ---
  ipcMain.handle('bookmarks:list', () => d.bookmarks.list());
  ipcMain.handle('bookmarks:add-current', () => {
    const tab = d.tabs.active();
    if (tab && tab.url) return d.bookmarks.add({ title: tab.title || tab.url, url: tab.url });
    return d.bookmarks.list();
  });
  ipcMain.handle('bookmarks:remove', (_e, url: string) => d.bookmarks.remove(url));

  // --- settings ---
  ipcMain.handle('settings:get', () => d.settings.get());
  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => d.settings.set(patch));

  // --- downloads ---
  ipcMain.handle('downloads:list', () => d.downloads.list());

  // --- UI bootstrap: everything the chrome needs in one round trip ---
  ipcMain.handle('ui:init', () => ({
    bookmarks: d.bookmarks.list(),
    retailers: d.retailers.map((r) => ({ name: r.name, homepage: r.homepage })),
    settings: d.settings.get(),
    tabs: d.tabs.state()
  }));

  // --- perf stats for the UI stats chip / diagnostics ---
  ipcMain.handle('stats:get', () => ({
    timeline: timeline.snapshot(),
    warmup: timeline.warmup,
    flags: d.appliedFlags,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }));

  // --- page metrics from page preloads → hub (bench) + UI stats chip ---
  ipcMain.on('page:metrics', (e, payload: PageMetrics) => {
    if (!payload || typeof payload !== 'object') return;
    hub.emitNav(e.sender.id, payload);
    if (payload.phase === 'settled' && payload.url !== 'about:blank' && d.settings.get().collectMetrics) {
      const win = d.getWin();
      if (win && !win.isDestroyed()) win.webContents.send('metrics:last', payload);
    }
  });
}
