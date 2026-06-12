/**
 * Startup banner — printed once after the router is ready.
 *
 * Advertises the router's LAN IPv4 endpoint(s) so the operator knows exactly
 * what to put in each LLMHost and LLMUser `SHAREGRID_ROUTER_URL`. The router
 * runs in a Docker container on a bridge network and therefore cannot see its
 * host machine's LAN IPv4 itself; the address(es) are injected via the
 * `SHAREGRID_LAN_IPS` env var by docker-run.sh, which detects them on the host
 * OS. ShareGrid connects modules over the LAN using IPv4.
 *
 * console.log is the ONLY sanctioned use in src/ outside config.ts; this is
 * deliberate operator-facing output, not structured application logging.
 *
 * See: docs/architecture_llmrouter.md §7
 */

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

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
export function printStartupBanner(opts: BannerOptions): void {
  const { listenAddr, fingerprint, hostSecret, userSecret } = opts;

  // Extract port from listenAddr (format: host:port).
  const lastColon = listenAddr.lastIndexOf(':');
  const port = listenAddr.slice(lastColon + 1);

  // ── LAN IPv4 candidates (injected from the host OS) ───────────────────────
  // A bridge-networked container can only see its Docker bridge IP, which is
  // not reachable from other machines, so the host's LAN IPv4 address(es) are
  // supplied via SHAREGRID_LAN_IPS by docker-run.sh.
  const candidates: string[] = [];
  const lanIps = (process.env['SHAREGRID_LAN_IPS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ip of lanIps) {
    if (!IPV4_REGEX.test(ip)) continue;
    if (ip.startsWith('127.')) continue; // loopback is not reachable from other machines
    if (!candidates.includes(ip)) candidates.push(ip);
  }

  // ── URL builder ───────────────────────────────────────────────────────────
  const buildUrl = (host: string, key: string): string =>
    `https://${host}:${port}?fp=${fingerprint}&key=${key}`;

  // ── Print banner ──────────────────────────────────────────────────────────
  console.log('');
  console.log('LLMRouter started.');
  console.log('');
  console.log(`  Listen address : ${listenAddr}`);
  console.log(`  TLS fingerprint: ${fingerprint}`);
  console.log('');

  if (candidates.length === 0) {
    console.log('  WARNING: no LAN IPv4 address was provided (SHAREGRID_LAN_IPS).');
    console.log('  Falling back to the raw listen address — replace the host with this');
    console.log("  machine's LAN IPv4 before distributing the URLs.");
    console.log('');
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    console.log(`    ${buildUrl(listenAddr, hostSecret)}`);
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    console.log(`    ${buildUrl(listenAddr, userSecret)}`);
  } else {
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    for (const ip of candidates) {
      console.log(`    ${buildUrl(ip, hostSecret).padEnd(80)}  [lan]`);
    }
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    for (const ip of candidates) {
      console.log(`    ${buildUrl(ip, userSecret).padEnd(80)}  [lan]`);
    }
  }

  console.log('');
}
