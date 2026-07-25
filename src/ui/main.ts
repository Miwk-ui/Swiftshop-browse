// Browser chrome UI. Vanilla TS on purpose: the whole UI bundle is a few KB,
// parses instantly, and owns no framework runtime that could contend with
// page rendering.
import type { ShopApi } from '../preload/chrome';
import type {
  Bookmark,
  DownloadState,
  PageMetrics,
  SettingsData,
  TabsState
} from '../shared/types';

declare global {
  interface Window {
    shop: ShopApi;
  }
}

const api = window.shop;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const tabsEl = $('#tabs');
const address = $<HTMLInputElement>('#address');
const statsEl = $('#stats');
const panel = $('#panel');
const chipsEl = $('#chips');

let state: TabsState = { tabs: [], activeId: -1 };
let openPanel: 'downloads' | 'bookmarks' | 'settings' | null = null;
let addressEditing = false;

// ---------- tabs ----------
function renderTabs(): void {
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (t.loading ? '◌ ' : '') + (t.title || 'New Tab');
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.onclick = (e) => {
      e.stopPropagation();
      api.closeTab(t.id);
    };
    el.append(title, close);
    el.onclick = () => api.activateTab(t.id);
    el.onauxclick = (e) => {
      if (e.button === 1) api.closeTab(t.id);
    };
    tabsEl.appendChild(el);
  }
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!addressEditing) address.value = active?.url ?? '';
  if (active && !active.url) address.focus();
}

api.onTabsState((s) => {
  state = s as TabsState;
  renderTabs();
});

// ---------- address bar ----------
function normalizeInput(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!v.includes(' ') && v.includes('.')) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
}

address.addEventListener('focus', () => {
  addressEditing = true;
  address.select();
});
address.addEventListener('blur', () => {
  addressEditing = false;
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = normalizeInput(address.value);
    if (url) {
      api.navigate(url);
      address.blur();
    }
  } else if (e.key === 'Escape') {
    address.blur();
  }
});
api.onFocusAddress(() => {
  address.focus();
  address.select();
});

// ---------- nav buttons ----------
$('#btn-back').onclick = () => api.back();
$('#btn-fwd').onclick = () => api.forward();
$('#btn-reload').onclick = () => api.reload();
$('#btn-newtab').onclick = () => api.newTab();
$('#btn-star').onclick = () => {
  void api.addBookmark();
};

// ---------- retailer quick chips (hover = preconnect, click = go) ----------
function renderChips(retailers: { name: string; homepage: string }[]): void {
  chipsEl.textContent = '';
  for (const r of retailers) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = r.name;
    chip.onmouseenter = () => api.warmOrigin(new URL(r.homepage).origin);
    chip.onclick = () => api.navigate(r.homepage);
    chipsEl.appendChild(chip);
  }
}

// ---------- stats chip (proof the metrics pipeline is live) ----------
api.onMetrics((p) => {
  const m = p as PageMetrics;
  if (!m.nav) return;
  const parts = [
    `TTFB ${Math.round(m.nav.ttfbMs)}ms`,
    m.fcpMs ? `FCP ${Math.round(m.fcpMs)}ms` : '',
    m.lcpMs ? `LCP ${Math.round(m.lcpMs)}ms` : '',
    m.nav.protocol
  ].filter(Boolean);
  statsEl.textContent = parts.join(' · ');
});

// ---------- panels ----------
function closePanel(): void {
  openPanel = null;
  panel.hidden = true;
  panel.textContent = '';
  api.setPanel(false);
}

function togglePanel(which: 'downloads' | 'bookmarks' | 'settings'): void {
  if (openPanel === which) {
    closePanel();
    return;
  }
  openPanel = which;
  panel.hidden = false;
  api.setPanel(true);
  void renderPanel();
}

async function renderPanel(): Promise<void> {
  panel.textContent = '';
  if (openPanel === 'downloads') renderDownloads((await api.getDownloads()) as DownloadState[]);
  else if (openPanel === 'bookmarks') renderBookmarks((await api.getBookmarks()) as Bookmark[]);
  else if (openPanel === 'settings') await renderSettings();
}

function renderDownloads(items: DownloadState[]): void {
  panel.textContent = '';
  const h = document.createElement('h3');
  h.textContent = 'Downloads';
  panel.appendChild(h);
  if (!items.length) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = 'No downloads yet.';
    panel.appendChild(n);
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = it.filename;
    const status = document.createElement('span');
    status.textContent =
      it.state === 'progressing'
        ? `${Math.round((it.receivedBytes / Math.max(1, it.totalBytes)) * 100)}%`
        : it.state;
    row.append(name, status);
    panel.appendChild(row);
  }
}

api.onDownloads((items) => {
  if (openPanel === 'downloads') renderDownloads(items as DownloadState[]);
});

function renderBookmarks(items: Bookmark[]): void {
  panel.textContent = '';
  const h = document.createElement('h3');
  h.textContent = 'Bookmarks';
  panel.appendChild(h);
  for (const b of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const link = document.createElement('a');
    link.className = 'grow';
    link.textContent = `${b.title} — ${b.url}`;
    link.onmouseenter = () => {
      try {
        api.warmOrigin(new URL(b.url).origin);
      } catch {
        /* invalid url */
      }
    };
    link.onclick = () => {
      api.navigate(b.url);
      closePanel();
    };
    const del = document.createElement('button');
    del.textContent = '×';
    del.onclick = async () => {
      renderBookmarks((await api.removeBookmark(b.url)) as Bookmark[]);
    };
    row.append(link, del);
    panel.appendChild(row);
  }
}

async function renderSettings(): Promise<void> {
  const s = (await api.getSettings()) as SettingsData;
  panel.textContent = '';
  const h = document.createElement('h3');
  h.textContent = 'Settings';
  panel.appendChild(h);

  const toggles: [keyof SettingsData, string, string?][] = [
    ['warmupOnLaunch', 'Warm DNS + preconnect retailer origins at launch'],
    ['idleSocketWarming', 'Keep retailer sockets warm while idle'],
    ['spareRenderer', 'Keep a warm spare renderer for instant new tabs'],
    ['restoreSession', 'Restore tabs from last session'],
    ['collectMetrics', 'Show page-load metrics in the tab strip'],
    ['hardwareAcceleration', 'Hardware (GPU) acceleration', 'requires restart']
  ];
  for (const [key, label, note] of toggles) {
    const row = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(s[key]);
    cb.onchange = () => {
      void api.setSettings({ [key]: cb.checked });
    };
    row.appendChild(cb);
    row.append(` ${label}${note ? ` (${note})` : ''}`);
    panel.appendChild(row);
  }

  const stats = await api.getStats();
  const pre = document.createElement('pre');
  pre.textContent = 'Startup & warmup diagnostics:\n' + JSON.stringify(stats, null, 2);
  panel.appendChild(pre);
}

$('#btn-downloads').onclick = () => togglePanel('downloads');
$('#btn-bookmarks').onclick = () => togglePanel('bookmarks');
$('#btn-settings').onclick = () => togglePanel('settings');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPanel) closePanel();
});

// ---------- bootstrap ----------
void (async () => {
  const init = (await api.init()) as {
    retailers: { name: string; homepage: string }[];
    tabs: TabsState;
  };
  renderChips(init.retailers);
  state = init.tabs;
  renderTabs();
})();
