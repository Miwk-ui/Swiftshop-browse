// Page preload: runs (sandboxed, context-isolated) in every tab. Its only job
// is passive performance measurement via the Performance API — it never
// modifies page content or behavior.
import { ipcRenderer } from 'electron';

(() => {
  try {
    performance.setResourceTimingBufferSize(1000);
  } catch {
    // older engines: default buffer
  }

  let lcpMs = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { renderTime?: number; loadTime?: number };
        const t = e.renderTime || e.loadTime || e.startTime;
        if (t > lcpMs) lcpMs = t;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // LCP observer unsupported on this document type
  }

  function collect(phase: 'settled' | 'final'): void {
    try {
      const navs = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const n = navs[0];
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0;

      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const byHost = new Map<string, { count: number; transferBytes: number }>();
      let transferBytes = 0;
      let cacheHits = 0;
      let sizedCount = 0;
      for (const r of res) {
        let host = '';
        try {
          host = new URL(r.name).host;
        } catch {
          // opaque URL
        }
        const b = byHost.get(host) ?? { count: 0, transferBytes: 0 };
        b.count++;
        b.transferBytes += r.transferSize || 0;
        byHost.set(host, b);
        transferBytes += r.transferSize || 0;
        if (r.decodedBodySize > 0) {
          sizedCount++;
          if (r.transferSize === 0) cacheHits++;
        }
      }
      const topHosts = [...byHost.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([host, v]) => ({ host, count: v.count, transferBytes: v.transferBytes }));

      const payload = {
        phase,
        url: location.href,
        timeOrigin: performance.timeOrigin,
        nav: n
          ? {
              redirectMs: n.redirectEnd - n.redirectStart,
              dnsMs: n.domainLookupEnd - n.domainLookupStart,
              connectMs: n.connectEnd - n.connectStart,
              tlsMs: n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0,
              ttfbMs: n.responseStart,
              requestMs: n.responseStart - n.requestStart,
              responseMs: n.responseEnd - n.responseStart,
              domContentLoadedMs: n.domContentLoadedEventEnd,
              loadMs: n.loadEventEnd,
              transferSize: n.transferSize,
              encodedBodySize: n.encodedBodySize,
              protocol: (n as PerformanceNavigationTiming & { nextHopProtocol?: string }).nextHopProtocol ?? '',
              type: n.type
            }
          : null,
        fcpMs: fcp,
        lcpMs,
        resources: { count: res.length, transferBytes, cacheHits, sizedCount, topHosts }
      };
      ipcRenderer.send('page:metrics', payload);
    } catch {
      // measurement must never break a page
    }
  }

  let settledSent = false;
  window.addEventListener('load', () => {
    // 3s after load: lets LCP and late resources land before the snapshot.
    setTimeout(() => {
      if (!settledSent) {
        settledSent = true;
        collect('settled');
      }
    }, 3000);
  });
  window.addEventListener('pagehide', () => collect('final'));
})();
