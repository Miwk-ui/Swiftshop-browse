# Architecture

SwiftShop is a minimal Electron/Chromium browser whose entire design revolves around one idea:
**keep everything warm, and never claim a win without measuring it.**

## Process model

```
┌────────────────────────────────────────────────────────────────┐
│ Main process (Node)                                            │
│  index.ts ── startup sequencing, timestamped phases            │
│  flags.ts ── Chromium switches (only benchmark-proven ones)    │
│  warmup.ts ─ DNS resolve + TCP/TLS preconnect + idle rewarming │
│  tabs.ts ─── TabManager: WebContentsView per tab + warm spare  │
│  bench.ts ── in-app benchmark controller (--bench=...)         │
├────────────────────────────────────────────────────────────────┤
│ Chrome UI renderer (sandboxed)                                 │
│  ~4.5 kB vanilla TS bundle: tab strip, address bar, panels     │
├────────────────────────────────────────────────────────────────┤
│ Page renderers (sandboxed, site-isolated by Chromium)          │
│  page preload: passive Performance API metrics only            │
├────────────────────────────────────────────────────────────────┤
│ GPU process · Network service — created once, reused for life  │
└────────────────────────────────────────────────────────────────┘
```

- **One persistent session partition** (`persist:swiftshop`): HTTP cache, cookies,
  localStorage, IndexedDB, service workers, and TLS state all live in one profile that
  survives restarts. Logins persist; caches stay warm across sessions. Cookies are
  encrypted at rest by Chromium (DPAPI on Windows).
- **Warm spare renderer**: after launch, a hidden `WebContentsView` with `about:blank`
  is pre-created so opening a tab never pays renderer-process startup. (Chromium site
  isolation may still swap the process on cross-site navigation — which is why this is
  a benchmarked toggle, not an assumption. See OPTIMIZATIONS.md.)
- **Single-instance lock**: launching the app while it's already running focuses the
  existing warm window instead of paying cold start again. `--hidden` supports a
  start-minimized resident mode.
- **Tab switching** is `View.setVisible()` on already-attached views — no process or
  view creation on the switch path.
- **Session restore** is lazy: only the active tab loads at startup; background tabs
  keep their URL and load on first activation, so restore cost is O(1) in tabs.

## Startup sequencing (measured, in order)

1. *(pre-ready, synchronous)* parse args → set profile dir → apply tuned Chromium flags
2. `app.whenReady` → apply tuned DNS-over-HTTPS config if benchmarks chose one
3. Create window → register IPC → load chrome UI (nothing network-related blocks this)
4. **After** the window is visible: DNS warmup, preconnect, spare renderer

Every phase writes a timestamp into the timeline (`metrics.ts`), so `npm run bench:startup`
attributes cost to each step. Nothing user-visible waits on warmup.

## Network warmup engine (`warmup.ts`)

At launch (and periodically while idle, since servers close idle keep-alive sockets):

- `session.resolveHost()` for every host in every retailer profile → DNS cache hot
- `session.preconnect({url, numSockets: 2})` per retailer origin → TCP+TLS handshakes
  done before the user clicks anything
- Hovering a retailer chip or bookmark preconnects that origin (1 socket) — the same
  speculative pattern Chrome uses for link hover

No retailer page is ever loaded without user interaction; only network state is prepared.

## Metrics pipeline

```
page preload (Performance API observer)
   └─ ipc 'page:metrics' ─→ main hub ─┬─→ bench controller (when --bench)
                                      └─→ chrome UI stats chip (live TTFB/FCP/LCP)
```

The page preload is passive: buffered `PerformanceObserver` for LCP, navigation/paint/
resource entries snapshotted 3 s after `load`. It never mutates page content.

## Benchmark & tuning loop

```
npm run tune
  └─ bench/run-bench.ts spawns the app N× per variant (isolated profiles)
       variants = baseline · no-warmup · each flag set in config/flags.json
       + DNS providers: system · cloudflare · google
  └─ statistics (median/p90/stdev) per variant
  └─ decideTuning(): candidate wins only with ≥5% median improvement
       and no startup regression; DNS must beat system by ≥10 ms
  └─ writes config/tuning.json (with embedded evidence)
       → next launch applies exactly the winners, nothing else
```

This is the enforcement mechanism for the project's core rule: **optimizations are
enabled by measurement, not by belief.**

## Security posture

Standard browser security is not traded for speed:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` everywhere
- Same-origin policy, certificate validation, CSP untouched
- Permission requests (notifications, geolocation, media) denied by default
- The chrome UI has a strict CSP and talks to main only through a narrow,
  typed `contextBridge` API

## Source layout

```
src/main/      main process (entry, tabs, warmup, bench, ipc, menu, stores)
src/preload/   chrome.ts (UI bridge) · page.ts (passive metrics)
src/ui/        vanilla-TS chrome: tab strip, toolbar, panels
src/shared/    types shared across all layers
bench/         run-bench.ts (orchestrator+tuner) · report.ts · compare-browsers.ts
config/        retailers/*.json · flags.json · tuning.json · browsers.json
docs/          this file · OPTIMIZATIONS.md · BENCHMARKING.md · ROADMAP.md
```
