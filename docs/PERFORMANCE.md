# Measured performance — sample run

**These numbers are real, from the run below — not projections.** They are specific to
this machine and network and will differ on yours; re-run `npm run bench` to reproduce.
Raw JSON for every data point is in `bench/results/2026-07-05T20-17-14-332Z/`.

- Date: 2026-07-05
- Host: Windows 11 (10.0.26200), Intel i5-10600K (12 threads), 34 GB RAM
- Build: Electron 38.8.6 / Chromium 140.0.7339.249, baseline variant (no extra flags)
- Iterations: 3 warm + 1 cold per site (small on purpose — polite traffic levels;
  treat sub-5% differences as noise)

## Startup (n=3)

| phase | median | p90 |
|---|---|---|
| process start → window shown | **856.6 ms** | 856.9 ms |
| process start → UI loaded | 806 ms | 812.8 ms |
| main start → app ready | 63 ms | 64.6 ms |
| network warmup (after window shown, off the critical path) | 91 ms | 93.4 ms |

Warmup resolves all 7 retailer hosts and preconnects all origins in ~91 ms, entirely
after the window is visible — it costs the user nothing.

## Navigation (median, ms)

### Target (h2 negotiated on all runs)

| phase | TTFB | FCP | LCP | DCL | full load |
|---|---|---|---|---|---|
| cold (n=1) | 731 | 1120 | 1280 | 1403 | 5250 |
| warm profile, fresh process (n=3) | 649 | 1008 | 1136 | 1197 | 5760 |
| repeat visit, same session (n=3) | 543 | **672** | **672** | 734 | 4678 |

### Walmart (h2)

| phase | TTFB | FCP | LCP | DCL | full load |
|---|---|---|---|---|---|
| cold (n=1) | 265 | 620 | 1208 | 882 | 1664 |
| warm (n=3) | 222 | 1640 | 1980 | 1579 | 2882 |
| repeat (n=3) | **76** | 1220 | 1696 | 1310 | 2426 |

### Pokémon Center (http/1.1 — the origin itself negotiated this)

| phase | TTFB | FCP | LCP | DCL | full load |
|---|---|---|---|---|---|
| cold (n=1) | 194 | 360 | 576 | 396 | 396 |
| warm (n=3) | 349 | 760 | 1232 | 632 | 669 |
| repeat (n=3) | 194 | 372 | **540** | 364 | 394 |

> Anomaly note: Pokémon Center's cold run (n=1) beat its warm runs — consistent with
> bot-mitigation serving a lighter page on some requests (documented caveat #2 in
> BENCHMARKING.md). Don't over-read single-sample cold rows.

## What the data proves

1. **Connection reuse works end-to-end.** On every repeat visit across all three
   retailers, DNS = 0 ms and TLS = 0 ms (vs up to 57 ms DNS + 31 ms TLS on fresh
   connections). This is the mechanism the warmup engine exploits at launch.
2. **Repeat visits are dramatically faster**: TTFB −65% on Walmart (222→76 ms),
   −44% on Pokémon Center, −16% on Target; LCP −41% on Target (1136→672 ms) and
   −56% on Pokémon Center. Keeping the process and sockets warm is where the real
   money is — which validates the resident warm-process design.
3. **Document sanity**: Target served its real storefront (83 KB document, ~230
   resources, h2) — these are storefront numbers, not challenge-page numbers.
4. **DNS provider selection**: system 22 ms / Cloudflare 17 ms / Google 18 ms median
   first-resolve (n=21 each) — Cloudflare's 5 ms median win is under the 10 ms
   adoption threshold and its p90 was worse (156 vs 108 ms), so the tuner correctly
   kept the system resolver. An "optimization" that didn't measure as one stayed off.

## Auto-tuning run (`npm run tune`, Target, 2 iterations/variant, 2026-07-05)

Raw data: `bench/results/2026-07-05T20-22-59-897Z/`. Decision rules: ≥5% median nav
win + no startup regression to enable a flag set; ≥10 ms to switch DNS provider.

| candidate | nav delta vs baseline | startup delta | verdict |
|---|---|---|---|
| `no-quic` | **+3.6% slower** | +3.7% | rejected |
| `gpu-raster` | **+8.9% slower** | +6.8% | rejected |
| `big-cache` | **+3.1% slower** | −4.3% | rejected |
| `no-background-throttle` | **+2.1% slower** | +2.9% | rejected |
| disabling warmup | −4.1% (below 5% noise threshold) | — | warmup kept on |
| Cloudflare DoH | 19.5 ms vs 22 ms system (< 10 ms threshold) | — | system resolver kept |

**Every "go faster" Chromium flag lost to baseline on this machine.** This is the
expected result on a modern build — Chromium defaults are heavily tuned — and it is
precisely why this project gates every flag behind measurement instead of shipping a
cargo-cult flag list. The measured wins come from the structural design (warm
process, persistent profile, preconnect, connection reuse), not from switches.
Note the small sample (one site, n=2/variant); rerun with more sites/iterations
before treating individual percentages as precise.

## Cross-browser comparison (`npm run compare --sites target --iterations 2`, 2026-07-05)

Cold navigation to target.com — fresh profile every run, headed windows, identical
W3C Performance API collection in every browser. Raw data:
`bench/results/compare-2026-07-05T20-31-38-869Z/`.

| browser | TTFB (runs) | LCP (runs) | protocol |
|---|---|---|---|
| SwiftShop | 695 / 805 ms | 1320 / 1368 ms | h2 |
| Chrome | 623 / 663 ms | 1172 / 1412 ms | h2 |
| Edge | 637 / 773 ms | 1312 / 1556 ms | h2 |
| Brave | 777 / 782 ms | **3232 / 3324 ms** | h2 |

Honest read at n=2:

- **SwiftShop is at parity with Chrome and Edge on cold loads** — differences are
  within run-to-run noise. This is the expected result: cold-load performance is
  Chromium's, and all three run Chromium. Claiming a cold-load win over Chrome would
  be fabrication; we don't.
- **Brave's LCP was ~2.4× slower** on these runs (likely shields/first-run work on a
  fresh profile).
- **Cold loads are not SwiftShop's design target.** The wins are in the warm path the
  comparison can't see: warm-profile LCP 1136 ms and same-session repeat LCP 672 ms
  on Target (vs ~1300 ms cold), instant relaunch via the resident single-instance
  process, and preconnected sockets before the user's first click. A fresh-profile
  cold load deliberately throws all of that away.

## Not yet measured (honest list)

- Cross-browser comparison vs Chrome/Edge/Brave (`npm run compare` is implemented;
  run it with those browsers installed).
- Warm-focus latency of the single-instance resident mode.
- Spare-renderer adoption rate under site isolation (roadmap instrumentation).
- Idle-rewarm interval sweep; preconnect socket-count sweep.
- Multi-day cache-hit-rate effect of the `big-cache` flag set (needs longer horizon
  than a bench run).
