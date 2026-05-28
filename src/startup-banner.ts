/**
 * Startup banner — printed once after the router is ready.
 *
 * Enumerates non-loopback network interfaces and performs a best-effort
 * public-IP lookup. Prints candidate SHAREGRID_ROUTER_URL values so the
 * operator knows exactly what to put in each LLMHost and LLMUser env var.
 *
 * console.log is the ONLY sanctioned use in src/ outside config.ts; this is
 * deliberate operator-facing output, not structured application logging.
 *
 * See: docs/architecture_llmrouter.md §7
 *      docs/implementation_plan_llmrouter.md Phase 3D task 3D-1
 */

import { networkInterfaces } from 'node:os';

export interface BannerOptions {
  listenAddr: string;
  fingerprint: string;
}

/**
 * Print the startup banner to stdout.
 *
 * @param opts.listenAddr  The value of `SHAREGRID_LISTEN_ADDR` (e.g. `0.0.0.0:8443`).
 * @param opts.fingerprint The router's TLS cert fingerprint (e.g. `sha256:<hex>`).
 */
export async function printStartupBanner(opts: BannerOptions): Promise<void> {
  const { listenAddr, fingerprint } = opts;

  // Extract port from listenAddr (format: host:port).
  const lastColon = listenAddr.lastIndexOf(':');
  const port = listenAddr.slice(lastColon + 1);

  const candidates: Array<{ label: string; url: string }> = [];

  // ── Public IP lookup (best-effort, 2-second timeout) ─────────────────────
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch('https://api.ipify.org', { signal: controller.signal });
      const publicIp = (await res.text()).trim();
      if (publicIp.length > 0) {
        candidates.push({
          label: 'public',
          url: `https://${publicIp}:${port}?fp=${fingerprint}`,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Non-fatal: omit the [public] line and log a warning via console.log.
    console.log('  (public IP lookup failed or timed out — [public] line omitted)');
  }

  // ── Local interfaces ──────────────────────────────────────────────────────
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (addrs === undefined) continue;
    for (const addr of addrs) {
      // Skip loopback and IPv6 link-local.
      if (addr.internal) continue;
      if (addr.family !== 'IPv4') continue;
      candidates.push({
        label: name,
        url: `https://${addr.address}:${port}?fp=${fingerprint}`,
      });
    }
  }

  // ── Print banner ──────────────────────────────────────────────────────────
  console.log('');
  console.log('LLMRouter started.');
  console.log('');
  console.log(`  Listen address : ${listenAddr}`);
  console.log(`  TLS fingerprint: ${fingerprint}`);
  console.log('');

  if (candidates.length === 0) {
    console.log('  WARNING: no non-loopback interfaces found.');
    console.log(`  Raw listen address: https://${listenAddr}?fp=${fingerprint}`);
  } else {
    console.log('  Reachable endpoints (use as SHAREGRID_ROUTER_URL):');
    for (const { label, url } of candidates) {
      console.log(`    ${url.padEnd(70)}  [${label}]`);
    }
  }

  console.log('');
  console.log('  Copy one of the above into SHAREGRID_ROUTER_URL on each LLMHost and LLMUser.');
  console.log('');
}
