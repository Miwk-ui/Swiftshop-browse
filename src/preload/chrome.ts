// Preload for the browser chrome UI (tab strip / toolbar). Exposes a minimal,
// typed IPC surface — no Node access in the UI renderer.
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // bootstrap
  init: () => ipcRenderer.invoke('ui:init'),

  // tabs
  newTab: (url?: string) => ipcRenderer.send('tabs:new', url),
  closeTab: (id: number) => ipcRenderer.send('tabs:close', id),
  activateTab: (id: number) => ipcRenderer.send('tabs:activate', id),
  onTabsState: (cb: (state: unknown) => void) =>
    ipcRenderer.on('tabs:state', (_e, s) => cb(s)),

  // navigation
  navigate: (url: string) => ipcRenderer.send('nav:go', url),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),

  // speculative warming on hover
  warmOrigin: (origin: string) => ipcRenderer.send('warm:origin', origin),

  // panels push the page view down while open
  setPanel: (open: boolean) => ipcRenderer.send('chrome:panel', open),

  // bookmarks
  getBookmarks: () => ipcRenderer.invoke('bookmarks:list'),
  addBookmark: () => ipcRenderer.invoke('bookmarks:add-current'),
  removeBookmark: (url: string) => ipcRenderer.invoke('bookmarks:remove', url),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),

  // downloads
  getDownloads: () => ipcRenderer.invoke('downloads:list'),
  onDownloads: (cb: (items: unknown) => void) =>
    ipcRenderer.on('downloads:state', (_e, items) => cb(items)),

  // perf
  getStats: () => ipcRenderer.invoke('stats:get'),
  onMetrics: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('metrics:last', (_e, p) => cb(p)),
  onFocusAddress: (cb: () => void) => ipcRenderer.on('chrome:focus-address', () => cb())
};

contextBridge.exposeInMainWorld('shop', api);

export type ShopApi = typeof api;
