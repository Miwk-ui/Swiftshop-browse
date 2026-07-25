// Types shared across main process, preloads, UI, and bench tooling.

export interface RetailerProfile {
  name: string;
  homepage: string;
  dnsHosts: string[];
  preconnectOrigins: string[];
  socketsPerOrigin?: number;
  bookmarks: { title: string; url: string }[];
}

export interface FlagSet {
  /** [switchName, optionalValue] pairs passed to app.commandLine.appendSwitch */
  switches: [string, string?][];
  doc: string;
}

export interface FlagsFile {
  sets: Record<string, FlagSet>;
}

export interface Tuning {
  enabledSets: string[];
  dns: string | null;
  warmup: boolean;
  evidence: Record<string, unknown>;
}

export interface SettingsData {
  warmupOnLaunch: boolean;
  spareRenderer: boolean;
  idleSocketWarming: boolean;
  idleWarmIntervalSec: number;
  hardwareAcceleration: boolean;
  collectMetrics: boolean;
  restoreSession: boolean;
}

export interface Bookmark {
  title: string;
  url: string;
}

export interface TabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TabsState {
  tabs: TabState[];
  activeId: number;
}

export interface DownloadState {
  id: number;
  filename: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}

/** Navigation metrics collected in the page preload from the Performance API. */
export interface PageMetrics {
  phase: 'settled' | 'final';
  url: string;
  timeOrigin: number;
  nav: {
    redirectMs: number;
    dnsMs: number;
    connectMs: number;
    tlsMs: number;
    ttfbMs: number;
    requestMs: number;
    responseMs: number;
    domContentLoadedMs: number;
    loadMs: number;
    transferSize: number;
    encodedBodySize: number;
    protocol: string;
    type: string;
  } | null;
  fcpMs: number;
  lcpMs: number;
  resources: {
    count: number;
    transferBytes: number;
    /** transferSize===0 with decodedBodySize>0 — cache hits among size-visible resources */
    cacheHits: number;
    /** resources where sizes are visible (same-origin or Timing-Allow-Origin) */
    sizedCount: number;
    topHosts: { host: string; count: number; transferBytes: number }[];
  };
}

export interface WarmupResult {
  host: string;
  ms: number;
  endpoints: string[];
  error?: string;
}

export interface StartupSnapshot {
  marks: Record<string, number>;
  derived: Record<string, number | null>;
}
