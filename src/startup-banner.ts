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
  /** Role secret for host operators — embedded in host registration URLs. */
  hostSecret: string;
  /** Role secret for end users — embedded in user access URLs. */
  userSecret: string;
}

/**
 * Print the startup banner to stdout.
 *
 * Prints two separate labelled URL blocks:
 *  - HOST REGISTRATION URLs — distribute only to host operators.
 *  - USER ACCESS URLs       — distribute only to end users.
 *
 * @param opts.listenAddr  The value of `SHAREGRID_LISTEN_ADDR` (e.g. `0.0.0.0:8443`).
 * @param opts.fingerprint The router's TLS cert fingerprint (e.g. `sha256:<hex>`).
 * @param opts.hostSecret  Role secret embedded in host registration URLs.
 * @param opts.userSecret  Role secret embedded in user access URLs.
 */
export async function printStartupBanner(opts: BannerOptions): Promise<void> {
  const { listenAddr, fingerprint, hostSecret, userSecret } = opts;

  // Extract port from listenAddr (format: host:port).
  const lastColon = listenAddr.lastIndexOf(':');
  const port = listenAddr.slice(lastColon + 1);

  const candidates: Array<{ label: string; ip: string }> = [];

  // ── Public IP lookup (best-effort, 2-second timeout) ─────────────────────
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch('https://api.ipify.org', { signal: controller.signal });
      const publicIp = (await res.text()).trim();
      if (publicIp.length > 0) {
        candidates.push({ label: 'public', ip: publicIp });
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
      candidates.push({ label: name, ip: addr.address });
    }
  }

  // ── URL builder ───────────────────────────────────────────────────────────
  function buildUrl(ip: string, key: string): string {
    return `https://${ip}:${port}?fp=${fingerprint}&key=${key}`;
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
    console.log('');
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    console.log(`    ${buildUrl(listenAddr, hostSecret)}`);
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    console.log(`    ${buildUrl(listenAddr, userSecret)}`);
  } else {
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    for (const { label, ip } of candidates) {
      console.log(`    ${buildUrl(ip, hostSecret).padEnd(80)}  [${label}]`);
    }
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    for (const { label, ip } of candidates) {
      console.log(`    ${buildUrl(ip, userSecret).padEnd(80)}  [${label}]`);
    }
  }

  console.log('');
}
