# Roadmap — future optimizations

Everything here is a **hypothesis until benchmarked**. Items graduate into the product
only after `npm run tune`-style A/B evidence on real hardware.

## Near term

- **Resident background mode**: tray icon + start-at-login with `--hidden`, so the
  single-instance lock makes every "launch" a warm-window focus (~0 ms perceived).
  The plumbing exists (`--hidden`, second-instance focus); needs tray UX + autostart
  registration and a warm-launch benchmark mode that measures second-instance focus time.
- **Measure spare-renderer adoption**: instrument whether Chromium actually reuses the
  warm `about:blank` renderer on cross-site navigation under site isolation, or always
  swaps processes. If it always swaps, remove the feature (it costs ~80 MB working set).
- **Per-retailer service-worker warmup**: retailers that register service workers can
  serve app-shell instantly; verify whether SW registrations persist and activate on
  first navigation, and whether a background `navigator.serviceWorker` wake is possible
  without loading pages (likely not without user interaction — verify).
- **Search-in-address-bar provider setting** and history-based autocomplete (perf-neutral
  UX gaps).

## Networking experiments (benchmark harness already supports A/B)

- **IPv4 vs IPv6 preference**: resolveHost already returns both families; test forcing
  family preference via host resolver options and measure handshake deltas.
- **HTTP/3 forcing/probing**: `origin-to-force-quic-on` for origins with proven-h3
  support; compare against negotiated default. The nav bench already records
  `nextHopProtocol` as ground truth.
- **Preconnect socket count tuning**: 1 vs 2 vs 4 sockets per origin (diminishing
  returns vs server socket pressure).
- **Idle rewarm interval sweep**: current 55 s is a guess at typical server idle
  timeouts; sweep 30/55/90/120 s and measure handshake-on-click rates.
- **Additional DoH providers** (Quad9, NextDNS) in the dns bench.

## Rendering / memory

- **Font and shader cache priming**: verify GPU shader disk cache persists across
  restarts in the persistent partition and measure first-paint deltas.
- **Tab discarding policy**: automatic discard of long-idle background tabs (memory
  floor for many-tab shopping sessions), with instant lazy reload — reuse the
  session-restore lazy-tab machinery.
- **Native module experiments**: none currently justified; the rule is a native module
  enters only if a benchmark shows the JS/IPC path is the bottleneck.

## Benchmarking

- **Firefox comparison** via WebDriver BiDi in compare-browsers.
- **CI perf gates**: run bench on a schedule against a fixed reference page (own
  infrastructure, not retailers) to catch regressions from Electron upgrades.
- **Challenge-page detection**: flag runs whose document transfer size is anomalously
  small so bot-challenge samples don't pollute retailer statistics.
- **Frame-timing capture** during scroll on product grids (input latency benchmarking).

## Retailer profiles

- Auto-suggest profile updates from `npm run profile` output (top hosts → PR-style diff
  to the profile JSON instead of a text recommendation).
- More retailers via `config/retailers/*.json` — the format is already generic.
