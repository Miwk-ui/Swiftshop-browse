# Benchmark methodology

The benchmark suite is the project's source of truth. Nothing in `config/tuning.json`
gets enabled without numbers from these tools, produced on the machine that will run
the browser.

## Tools

| command | what it measures |
|---|---|
| `npm run bench` | startup + navigation, baseline variant |
| `npm run bench:startup` | process start → app ready → window shown → UI loaded |
| `npm run bench:nav` | full navigation metrics against the three retailers |
| `npm run bench:dns` | system resolver vs Cloudflare DoH vs Google DoH |
| `npm run tune` | full A/B across all variants; writes `config/tuning.json` |
| `npm run profile` | visits each retailer, emits bottleneck recommendations |
| `npm run compare` | cold-navigation comparison vs installed Chrome/Edge/Brave |
| `npm run report` | regenerates report.md / report.html for the newest run |

Useful options: `--iterations N`, `--sites target,walmart`, `--variants baseline,gpu-raster,no-warmup`,
`--url https://...` for a custom page.

## Definitions

- **Cold navigation**: brand-new profile directory — empty HTTP cache, no cookies, no
  TLS state. Measured on run 0 of each nav series.
- **Warm navigation**: same profile reused across app launches — populated disk cache,
  but a fresh process (no live sockets). This approximates "user opens the browser and
  goes to Target like they do every day."
- **Repeat visit**: second navigation to the same URL within one app session — live
  sockets, memory cache. This is where connection reuse shows up.
- **Startup**: `process.getCreationTime()` → window shown / UI loaded, from the app's
  own timeline marks.

## Metrics collected per navigation

From the W3C Performance API (Navigation Timing, Paint Timing, LCP, Resource Timing):

DNS ms · TCP connect ms · TLS ms · TTFB · request/response ms · DOMContentLoaded ·
load · First Contentful Paint · Largest Contentful Paint · transfer size · **negotiated
protocol** (`h2` vs `h3` — direct evidence of whether QUIC is actually used) · resource
count/bytes/cache-hits · per-process CPU and working-set memory (`app.getAppMetrics()`).

## Statistics

Each variant × metric reports **median, p90, mean, stdev, min, max, n**. Medians are
compared; p90 guards against variants that are fast on average but spiky.

The tuner's decision rules (deliberately conservative):

- Flag set enabled only if it improves the primary nav metric (LCP, falling back to
  load) by **≥ 5% median across sites** with **no >5% startup regression**.
- Warmup disabled only if disabling it measured ≥ 5% faster (i.e., it actively hurt).
- A DoH provider is chosen only if its median first-resolve beats the system resolver
  by **≥ 10 ms**.

## Honest caveats — read before trusting any number

1. **Public-internet noise.** CDN edge selection, peering weather, and time of day move
   these numbers. Differences under ~5% are noise at these sample sizes. Increase
   `--iterations` for finer distinctions.
2. **Bot mitigation.** Target and Walmart (Akamai/PerimeterX-family) and Pokémon Center
   (Imperva) may serve challenge pages to automated-looking traffic. Metrics measure
   whatever HTML was actually served. A challenge page is lighter than the storefront,
   which can make numbers look *better* than real browsing. Treat retailer numbers as
   network-path measurements first, page-weight measurements second. For truthful
   end-to-end numbers, browse manually with `collectMetrics` on and read the stats chip.
3. **Cross-origin Resource Timing limits.** Sizes/timings of cross-origin resources
   without `Timing-Allow-Origin` are zeroed by spec. Cache-hit rates are computed only
   over size-visible resources.
4. **DNS caching layers.** The OS cache serves the "system" provider; DoH bypasses it.
   The dns bench reports first-pass and cached-pass separately, but a truly cold OS
   cache cannot be guaranteed without flushing it (`ipconfig /flushdns`) between runs.
5. **"Cold" start isn't fully cold.** After the first run, Windows has the Electron
   binary in the OS file cache. True cold-boot numbers require a reboot; what we
   measure is "cold app, warm OS" — which is also the case users hit daily.
6. **Cross-browser comparison** uses identical Performance-API collection in every
   browser, headed, fresh profile per run — but only page-load metrics are compared.
   App startup times are not comparable across different harnesses and are not reported.
7. **Politeness.** The harness spaces runs ~2 s apart and defaults to small iteration
   counts. Total traffic stays at human-browsing levels. Don't crank iterations into
   the hundreds against retail sites; use `--url` against your own infrastructure for
   high-volume experiments.

## Workflow

```
npm run bench          # establish baseline numbers
npm run tune           # A/B everything; tuning.json gets only the winners
npm run bench          # confirm the tuned config actually reproduces the win
npm run profile        # find new bottlenecks / missing preconnect hosts
npm run compare        # sanity-check against Chrome/Edge/Brave
```

Re-run `npm run tune` when the network, machine, or retailer front-ends change —
a tuning decision is a measurement of a moment, not a permanent truth.
