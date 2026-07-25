import { BrowserWindow, Menu, WebContentsView, app, clipboard } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PARTITION } from './config';
import type { Settings } from './settings';
import type { TabsState } from '../shared/types';

/** Height of the chrome UI band; page views render below it. */
export const CHROME_HEIGHT = 84;
/** Chrome band height while a dropdown panel (downloads/settings/bookmarks) is open. */
const EXPANDED_HEIGHT = 404;

interface Tab {
  id: number;
  view: WebContentsView;
  title: string;
  url: string;
  loading: boolean;
  /** Lazy-restored tabs keep their URL here and load on first activation. */
  pendingUrl: string | null;
}

export class TabManager {
  private readonly tabs = new Map<number, Tab>();
  private order: number[] = [];
  private activeId = -1;
  private nextId = 1;
  /** Pre-created renderer with about:blank loaded so a new tab / first
   *  navigation doesn't pay renderer-process startup. Effectiveness is
   *  benchmarked (Chromium site isolation may still swap processes on
   *  cross-site navigation) — see docs/OPTIMIZATIONS.md. */
  private spare: WebContentsView | null = null;
  private panelOpen = false;
  private readonly sessionFile = path.join(app.getPath('userData'), 'session.json');
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly win: BrowserWindow,
    private readonly settings: Settings
  ) {}

  private createView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: path.join(app.getAppPath(), 'dist', 'preload', 'page.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    try {
      (view as unknown as { setBackgroundColor?: (c: string) => void }).setBackgroundColor?.('#ffffff');
    } catch {
      // cosmetic only
    }
    return view;
  }

  ensureSpare(): void {
    if (this.spare) return;
    this.spare = this.createView();
    void this.spare.webContents.loadURL('about:blank');
  }

  newTab(url?: string, opts: { activate?: boolean; lazy?: boolean } = {}): number {
    const view = this.spare ?? this.createView();
    this.spare = null;
    if (this.settings.get().spareRenderer) {
      setTimeout(() => this.ensureSpare(), 4000);
    }
    const id = this.nextId++;
    const tab: Tab = {
      id,
      view,
      title: url ? url : 'New Tab',
      url: url ?? '',
      loading: false,
      pendingUrl: opts.lazy && url ? url : null
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.wireEvents(tab);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    if (opts.activate !== false) this.activate(id);
    if (url && !opts.lazy) void view.webContents.loadURL(url);
    this.broadcast();
    return id;
  }

  activate(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.activeId = id;
    for (const [tid, t] of this.tabs) t.view.setVisible(tid === id);
    if (tab.pendingUrl) {
      const url = tab.pendingUrl;
      tab.pendingUrl = null;
      void tab.view.webContents.loadURL(url);
    }
    this.layout();
    tab.view.webContents.focus();
    this.broadcast();
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    try {
      tab.view.webContents.close();
    } catch {
      // already gone
    }
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) {
      const next = this.order[this.order.length - 1];
      if (next !== undefined) this.activate(next);
      else this.newTab();
    }
    this.broadcast();
  }

  closeActive(): void {
    if (this.activeId >= 0) this.close(this.activeId);
  }

  cycle(dir: 1 | -1): void {
    if (this.order.length < 2) return;
    const idx = this.order.indexOf(this.activeId);
    const next = this.order[(idx + dir + this.order.length) % this.order.length];
    if (next !== undefined) this.activate(next);
  }

  navigate(url: string): void {
    const tab = this.active();
    if (tab) void tab.view.webContents.loadURL(url);
    else this.newTab(url);
  }

  navigateTab(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (tab) void tab.view.webContents.loadURL(url);
  }

  back(): void {
    const wc = this.activeWc();
    if (!wc) return;
    const nh = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; goBack(): void } }).navigationHistory;
    if (nh?.canGoBack()) nh.goBack();
  }

  forward(): void {
    const wc = this.activeWc();
    if (!wc) return;
    const nh = (wc as unknown as { navigationHistory?: { canGoForward(): boolean; goForward(): void } }).navigationHistory;
    if (nh?.canGoForward()) nh.goForward();
  }

  reload(ignoreCache = false): void {
    const wc = this.activeWc();
    if (!wc) return;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  }

  stop(): void {
    this.activeWc()?.stop();
  }

  zoom(delta: number): void {
    const wc = this.activeWc();
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
  }

  openDevTools(): void {
    this.activeWc()?.openDevTools({ mode: 'detach' });
  }

  active(): Tab | undefined {
    return this.tabs.get(this.activeId);
  }

  activeWc(): Electron.WebContents | undefined {
    return this.active()?.view.webContents;
  }

  webContentsId(id: number): number {
    return this.tabs.get(id)?.view.webContents.id ?? -1;
  }

  setPanel(open: boolean): void {
    this.panelOpen = open;
    this.layout();
  }

  layout(): void {
    const { width, height } = this.win.getContentBounds();
    const top = this.panelOpen ? EXPANDED_HEIGHT : CHROME_HEIGHT;
    const tab = this.active();
    if (tab) {
      tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    }
  }

  /** Persist open tabs so a restart restores the session (lazily — only the
   *  active tab loads immediately; background tabs load on first activation). */
  saveSession(): void {
    try {
      const urls = this.order
        .map((id) => {
          const t = this.tabs.get(id);
          return t ? (t.pendingUrl ?? t.url) : '';
        })
        .filter((u) => u && u !== 'about:blank');
      const activeTab = this.active();
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify({ urls, activeUrl: activeTab?.url ?? '' })
      );
    } catch {
      // non-fatal
    }
  }

  private scheduleSave(): void {
    if (!this.settings.get().restoreSession) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveSession(), 1500);
  }

  restoreSession(): boolean {
    if (!this.settings.get().restoreSession) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')) as {
        urls: string[];
        activeUrl: string;
      };
      if (!raw.urls?.length) return false;
      let activeTabId = -1;
      for (const url of raw.urls) {
        const lazy = url !== raw.activeUrl;
        const id = this.newTab(url, { activate: false, lazy });
        if (!lazy) activeTabId = id;
      }
      this.activate(activeTabId >= 0 ? activeTabId : this.order[0]!);
      return true;
    } catch {
      return false;
    }
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents;
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.broadcast();
      this.scheduleSave();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.broadcast();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.broadcast();
    });
    const onNav = (url: string): void => {
      if (url && url !== 'about:blank') tab.url = url;
      this.broadcast();
      this.scheduleSave();
    };
    wc.on('did-navigate', (_e, url) => onNav(url));
    wc.on('did-navigate-in-page', (_e, url) => onNav(url));
    wc.setWindowOpenHandler(({ url }) => {
      this.newTab(url);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL) {
        template.push(
          { label: 'Open Link in New Tab', click: () => this.newTab(params.linkURL) },
          { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        );
      }
      if (params.isEditable) {
        template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
      } else if (params.selectionText) {
        template.push({ role: 'copy' }, { type: 'separator' });
      }
      template.push(
        { label: 'Back', enabled: true, click: () => this.back() },
        { label: 'Reload', click: () => this.reload() },
        { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) }
      );
      Menu.buildFromTemplate(template).popup();
    });
  }

  state(): TabsState {
    return {
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((t): t is Tab => !!t)
        .map((t) => {
          const wc = t.view.webContents;
          const nh = (wc as unknown as {
            navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean };
          }).navigationHistory;
          return {
            id: t.id,
            title: t.title,
            url: t.pendingUrl ?? t.url,
            loading: t.loading,
            canGoBack: nh?.canGoBack() ?? false,
            canGoForward: nh?.canGoForward() ?? false
          };
        }),
      activeId: this.activeId
    };
  }

  private broadcast(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send('tabs:state', this.state());
  }
}
