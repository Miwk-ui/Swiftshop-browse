import type { Session } from 'electron';
import type { RetailerProfile, WarmupResult } from '../shared/types';

/**
 * Network warmup. Runs right after the window is shown (never blocks UI):
 *  1. DNS: resolve every configured host so the resolver cache is hot.
 *  2. Preconnect: open TCP+TLS sockets to each retailer origin so the first
 *     real navigation skips DNS + TCP handshake + TLS handshake entirely.
 *
 * This only prepares network state — no retailer page is loaded without user
 * interaction.
 */
export async function warmDns(ses: Session, profiles: RetailerProfile[]): Promise<WarmupResult[]> {
  const hosts = [...new Set(profiles.flatMap((p) => p.dnsHosts))];
  const results = await Promise.all(
    hosts.map(async (host): Promise<WarmupResult> => {
      const t0 = Date.now();
      try {
        const r = await ses.resolveHost(host);
        return {
          host,
          ms: Date.now() - t0,
          endpoints: (r.endpoints ?? []).map((e) => e.address)
        };
      } catch (err) {
        return { host, ms: Date.now() - t0, endpoints: [], error: String(err) };
      }
    })
  );
  return results;
}

export function preconnectAll(ses: Session, profiles: RetailerProfile[]): void {
  for (const p of profiles) {
    for (const origin of p.preconnectOrigins) {
      try {
        ses.preconnect({ url: origin, numSockets: p.socketsPerOrigin ?? 2 });
      } catch {
        // preconnect is best-effort
      }
    }
  }
}

export function preconnectOrigin(ses: Session, origin: string): void {
  try {
    ses.preconnect({ url: origin, numSockets: 1 });
  } catch {
    // best-effort
  }
}

/**
 * Servers close idle keep-alive sockets (typically ~60s). Re-preconnecting on
 * an interval keeps a handshaken socket available so a click is never paying
 * a fresh TLS handshake. Tradeoff: a small amount of idle connection traffic
 * to the retailers. Configurable in settings; benchmark with `npm run tune`.
 */
export function startIdleWarming(
  ses: Session,
  profiles: RetailerProfile[],
  intervalSec: number
): () => void {
  const timer = setInterval(() => preconnectAll(ses, profiles), Math.max(20, intervalSec) * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
