# SwiftShop Browser

A minimal, measurement-driven desktop browser optimized for shopping on
**Target**, **Walmart**, and **Pokémon Center**.

Built on Electron (Chromium 140), TypeScript (strict), Vite, and esbuild — with zero
runtime dependencies. The core rule of the project: **no optimization ships without a
benchmark proving it wins on your machine.** The tuner (`npm run tune`) A/B-tests every
candidate against baseline and enables only measured winners.

## What makes it fast

- **Warm everything**: persistent profile (cache/cookies/TLS state survive restarts),
  DNS resolved and TCP+TLS sockets preconnected to retailer origins at launch, idle
  socket rewarming, warm spare renderer, single-instance lock so relaunch = focus.
- **Tiny chrome**: the whole UI is ~4.5 kB of framework-free JS. No splash, no
  animations, nothing competing with page rendering.
- **Adaptive, not superstitious**: Chromium flag sets, DoH providers, and warmup
  strategies are benchmarked per machine; `config/tuning.json` holds only proven
  winners, with the evidence embedded.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OPTIMIZATIONS.md](docs/OPTIMIZATIONS.md),
[docs/BENCHMARKING.md](docs/BENCHMARKING.md), [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
(measured results), and [docs/ROADMAP.md](docs/ROADMAP.md).

## Build & run

Requires [Node.js](https://nodejs.org/) 20 or later (includes `npm`). Windows/macOS/Linux
(developed and benchmarked on Windows 11).

```bash
npm install          # if the Electron binary fails to download, see Troubleshooting
npm run build        # Vite (UI) + esbuild (main/preload/bench) — sub-second rebuilds
npm start            # build + launch
```

## Using it

- `Ctrl+T` new tab · `Ctrl+W` close · `Ctrl+Tab` switch · `Ctrl+L` focus address
- `Alt+←/→` back/forward · `Ctrl+R` reload · `Ctrl+Shift+I` page devtools
- Retailer chips in the toolbar: hover preconnects, click navigates
- ☆ bookmarks the current page; panels for bookmarks/downloads/settings
- The right side of the tab strip shows live TTFB/FCP/LCP + protocol for the last page
- Session (tabs + logins) restores automatically on restart

## Benchmarks

```bash
npm run bench        # startup + navigation vs the three retailers
npm run tune         # full A/B: flag sets × warmup × DNS providers → tuning.json
npm run profile      # per-retailer bottleneck analysis + recommendations
npm run compare      # vs your installed Chrome / Edge / Brave (page-load metrics)
npm run report       # regenerate report.md / report.html for the newest run
```

Results land in `bench/results/<timestamp>/` as raw JSON + `summary.json` +
`report.md` + `report.html`. Read the caveats in
[docs/BENCHMARKING.md](docs/BENCHMARKING.md) before quoting numbers.

## Configuration

- `config/retailers/*.json` — retailer profiles (homepage, DNS hosts, preconnect
  origins, bookmarks). Add a file to add a retailer; `npm run profile` suggests hosts.
- `config/flags.json` — documented Chromium switch candidates (all off by default).
- `config/tuning.json` — machine-specific winners, written by `npm run tune`.
- `config/browsers.json` — browser paths for `npm run compare`.

## Deployment / packaging

Development runs from source (`npm start`). To ship an installer, add
[electron-builder](https://www.electron.builder):

```bash
npm i -D electron-builder
npx electron-builder --win nsis   # or --mac / --linux
```

Point its `files` config at `dist/**`, `config/**`, and `package.json`. For the
fastest perceived launches, register the app to start minimized at login with the
`--hidden` flag — the single-instance lock then turns every subsequent "launch" into
an instant focus of the already-warm window.

Keep Electron current (`npm i -D electron@latest` + re-run `npm run bench` to catch
regressions): each Chromium bump carries real networking/rendering improvements.

## Troubleshooting

**`Electron failed to install correctly`** — the postinstall download was blocked or
cached corrupt. Fix:

```powershell
# download the matching zip and extract it manually
curl.exe -L -o electron.zip https://github.com/electron/electron/releases/download/v38.8.6/electron-v38.8.6-win32-x64.zip
Expand-Archive electron.zip node_modules/electron/dist -Force
Set-Content -NoNewline node_modules/electron/path.txt "electron.exe"
```

**Retailer numbers look "too good"** — bot mitigation may have served a lightweight
challenge page instead of the storefront. See caveat #2 in docs/BENCHMARKING.md.

## Security

Standard browser security intact: sandboxed renderers, context isolation, site
isolation, certificate validation, SOP/CSP. Permission prompts denied by default.
No security feature is traded for performance.

## Contributing

Issues and PRs welcome — new retailer profiles, benchmark results from other
machines, and additional platform coverage are all useful. Since every
optimization here must be benchmark-backed, PRs that change performance-sensitive
code should include `npm run bench` output for before/after.

## License

[Apache License 2.0](LICENSE)
