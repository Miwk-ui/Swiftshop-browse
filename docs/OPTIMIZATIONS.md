# Optimization catalog

Every optimization in SwiftShop, its mechanism, and its evidence status.

**Status legend**
- ✅ *measured* — verified by benchmark on the dev machine (see `bench/results/`)
- 🧪 *hypothesis* — implemented and benchmarkable, but not yet proven to win;
  OFF by default unless structurally free
- ⚙ *structural* — an architecture choice that avoids work entirely rather than doing
  it faster (measured indirectly through startup/nav numbers)

Numbers cited below come from the sample run recorded in [PERFORMANCE.md](PERFORMANCE.md).
Re-run `npm run bench` / `npm run tune` on your machine — network results do not
transfer between machines.

---

## Startup

### Warm-process design (⚙)
The app never tears down expensive Chromium subsystems. One persistent partition, one
GPU process, one network service for the app's lifetime. Tab switches toggle view
visibility; they never create processes.

### Single-instance lock + `--hidden` resident mode (⚙)
A second launch focuses the running warm window instead of booting Chromium again —
turning "launch" into a window-focus operation. `--hidden` supports starting minimized
at login. Warm-focus latency not yet instrumented (roadmap).

### Deferred warmup ordering (✅ by construction, measured)
Nothing network-related runs before the window is visible. The startup bench attributes
time per phase; warmup cost lands after `windowShown` and is therefore invisible to
perceived launch time (`warmupMs` is measured separately).

### Tiny chrome UI (⚙)
The whole browser chrome is ~4.5 kB of framework-free JS + ~2.5 kB CSS, no animations.
There is no framework runtime to parse on the startup path and nothing competing with
page renderers for frame time.

---

## Networking

### DNS warmup at launch (✅ mechanism verified)
`session.resolveHost()` for every configured retailer host right after window show.
Verified working: all 7 hosts resolve in ~45–70 ms total (parallel) at launch, so the
first navigation's DNS time is ~0 ms (see warm-nav dnsMs in the results).

### TCP+TLS preconnect at launch (✅ mechanism verified / 🧪 magnitude)
`session.preconnect({url, numSockets: 2})` per retailer origin. A first click then
skips DNS + TCP + TLS entirely (~1 RTT + TLS saved when it lands on a warm socket).
The `no-warmup` variant in `npm run tune` measures the actual end-to-end benefit —
which varies with how many sockets the site's first page actually needs.

### Idle socket rewarming (🧪)
Servers drop idle keep-alive sockets (~60 s typical). Re-preconnect every 55 s keeps a
handshaken socket available. Tradeoff: light idle traffic to retailers. Toggleable in
settings; interval sweep is on the roadmap.

### Hover-to-preconnect (⚙)
Hovering a retailer chip or bookmark preconnects that origin — the same speculative
pattern Chrome applies to links. By the time a human finishes a click (~150–300 ms),
the handshake is done or in flight.

### DNS-over-HTTPS provider selection (✅ benchmarked per machine)
`npm run bench:dns` races system resolver vs Cloudflare vs Google DoH; the tuner adopts
a DoH provider only if it beats system by ≥10 ms median. On the dev machine the system
resolver won — DoH stayed off. This is exactly the "measure, don't assume" outcome.

### HTTP/3 (QUIC) vs HTTP/2 (✅ observed, 🧪 tunable)
QUIC is on by Chromium default. The nav bench records the negotiated protocol
(`nextHopProtocol`) as ground truth per run. The `no-quic` flag set exists to detect
UDP-hostile networks where h2 wins; it is enabled only if it measures faster.

### HTTP cache, keep-alive, connection pooling, TLS session resumption (⚙)
Provided by Chromium's network service and preserved by the persistent partition —
the optimization here is *not resetting them*. Repeat-visit benchmarks confirm reuse
(repeat visits show ~0 ms DNS/connect/TLS).

---

## Chromium flag sets (all 🧪 until `npm run tune` proves them)

Defined in `config/flags.json`, each with rationale and tradeoffs:

| set | switches | expectation | tradeoff |
|---|---|---|---|
| `no-quic` | `--disable-quic` | wins only on UDP-hostile networks | loses h3 0-RTT |
| `gpu-raster` | `--enable-gpu-rasterization --enable-zero-copy` | faster paint of image grids | driver-dependent; can regress |
| `big-cache` | `--disk-cache-size=1GiB` | higher repeat-visit hit rate | disk usage |
| `no-background-throttle` | `--disable-background-timer-throttling --disable-renderer-backgrounding` | hotter background tabs/spare renderer | CPU/battery |

The deliberate absence of a long "speed flags" list is itself a finding: most
cargo-cult Chromium flags measure neutral-to-negative on modern builds. The tuner
keeps `enabledSets` empty unless a set proves a ≥5% median win here.

### User agent normalization (⚙, compatibility)
The session presents the standard Chrome UA string for the *actual* Chromium version
shipped (Electron's default appends `Electron/x`). Retailer sites vary content by UA;
this avoids degraded code paths. Same engine, honestly versioned — no security
implications, and no bot-evasion intent: automated benchmarking still identifies
itself by behavior and is rate-limited to polite levels.

---

## Renderer & memory

### Warm spare renderer (🧪 — honest open question)
A hidden `about:blank` WebContentsView pre-created after launch makes `Ctrl+T` instant.
**Open question**: under site isolation, cross-site navigation may swap the process
anyway, making this pure overhead (~80 MB). The roadmap has the instrumentation task;
until proven it stays a setting (on by default for UX, cheap to flip).

### Lazy session restore (⚙)
Restoring N tabs loads only the active one; background tabs hold a URL and load on
first activation. Restore cost is O(1) in tab count, and memory scales with tabs
*used*, not tabs *open*.

### Permission-denial by default (⚙)
Notifications/geolocation/media prompts are denied at the session level: no prompt UI,
and pages don't spin up the corresponding backends.

### Metrics collection is passive (⚙)
The page preload only reads Performance API buffers 3 s after load and on pagehide —
no MutationObservers, no polling, no content modification.

---

## What we deliberately did NOT do

- **No security trades.** Sandbox, site isolation, cert validation, SOP, CSP all intact.
- **No retailer-infrastructure games.** No IP pinning to "faster" edges, no protocol
  violations, no scraping/automation of checkout. We optimize our half of the connection.
- **No unmeasured flag soup.** Flags ship OFF; the tuner turns on winners only.
- **No content modification.** Pages render exactly as the retailer served them.
