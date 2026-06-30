/**
 * Startup banner — printed once after the router is ready.
 *
 * Advertises the router's endpoint(s) so the operator knows exactly what to put
 * in each LLMHost and LLMUser `SHAREGRID_ROUTER_URL`. The router runs in a
 * Docker container on a bridge network and therefore cannot see its host
 * machine's address itself; the address(es) are injected via the
 * `SHAREGRID_LAN_IPS` env var by docker-run.sh, which detects them on the host
 * OS. In `lan` mode the candidates are LAN IPv4 addresses; in `internet` mode
 * they are globally-routable IPv6 addresses, bracketed in the URL and stamped
 * with `mode=internet`.
 *
 * console.log is the ONLY sanctioned use in src/ outside config.ts; this is
 * deliberate operator-facing output, not structured application logging.
 *
 * See: docs/architecture_llmrouter.md §7
 */

import { formatEndpoint, isIPv6, type NetworkMode } from '@sharegrid/shared/tls';

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Reject IPv6 addresses that are not globally reachable: loopback (`::1`),
 * unspecified (`::`), link-local (`fe80::/10`) and unique-local (`fc00::/7`).
 */
function isAdvertisableIPv6(ip: string): boolean {
  if (!isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return false;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return false; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // fc00::/7 unique-local
  return true;
}

export interface BannerOptions {
  listenAddr: string;
  fingerprint: string;
  /** Router network mode; selects the advertised address family and URL `mode` param. */
  mode: NetworkMode;
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
  const { listenAddr, fingerprint, mode, hostSecret, userSecret } = opts;
  const internet = mode === 'internet';

  // Extract port from listenAddr (format: host:port, bracket-aware for IPv6).
  const lastColon = listenAddr.lastIndexOf(':');
  const port = listenAddr.slice(lastColon + 1);

  // ── Address candidates (injected from the host OS) ────────────────────────
  // A bridge-networked container can only see its Docker bridge IP, which is
  // not reachable from other machines, so the host's address(es) are supplied
  // via SHAREGRID_LAN_IPS by docker-run.sh. The accepted family depends on the
  // network mode: IPv4 in `lan` mode, globally-routable IPv6 in `internet` mode.
  const candidates: string[] = [];
  const lanIps = (process.env['SHAREGRID_LAN_IPS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ip of lanIps) {
    if (internet) {
      if (!isAdvertisableIPv6(ip)) continue;
    } else {
      if (!IPV4_REGEX.test(ip)) continue;
      if (ip.startsWith('127.')) continue; // loopback is not reachable from other machines
    }
    if (!candidates.includes(ip)) candidates.push(ip);
  }

  const modeSuffix = internet ? '&mode=internet' : '';
  const tag = internet ? '[internet]' : '[lan]';
  const family = internet ? 'globally-routable IPv6' : 'LAN IPv4';

  // ── URL builder ───────────────────────────────────────────────────────────
  // formatEndpoint brackets IPv6 literals so the URL parses correctly.
  const buildUrl = (host: string, key: string): string =>
    `https://${formatEndpoint(host, Number(port))}?fp=${fingerprint}&key=${key}${modeSuffix}`;

  // ── Base64 encoder ────────────────────────────────────────────────────────
  // Encode a URL to a single-line, copy-paste-safe base64 token.
  const toBase64Token = (url: string): string =>
    Buffer.from(url, 'utf-8').toString('base64');

  // ── Print banner ──────────────────────────────────────────────────────────
  console.log('');
  console.log('LLMRouter started.');
  console.log('');
  console.log(`  Listen address : ${listenAddr}`);
  console.log(`  Network mode   : ${mode}`);
  console.log(`  TLS fingerprint: ${fingerprint}`);
  console.log('');

  if (candidates.length === 0) {
    // Fallback: no usable address was injected. Print the raw listen authority
    // as-is (it already carries a port) so the operator can hand-edit it.
    const rawUrl = (key: string): string =>
      `https://${listenAddr}?fp=${fingerprint}&key=${key}${modeSuffix}`;
    console.log(`  WARNING: no ${family} address was provided (SHAREGRID_LAN_IPS).`);
    console.log('  Falling back to the raw listen address — replace the host with this');
    console.log(`  machine's ${family} address before distributing the URLs.`);
    console.log('');
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    const hostUrl = rawUrl(hostSecret);
    console.log(`    ${hostUrl}`);
    console.log(`    Token: ${toBase64Token(hostUrl)}`);
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    const userUrl = rawUrl(userSecret);
    console.log(`    ${userUrl}`);
    console.log(`    Token: ${toBase64Token(userUrl)}`);
  } else {
    console.log('  HOST REGISTRATION URLs (distribute only to host operators):');
    for (const ip of candidates) {
      const url = buildUrl(ip, hostSecret);
      console.log(`    ${url.padEnd(80)}  ${tag}`);
      console.log(`    Token: ${toBase64Token(url)}`);
    }
    console.log('');
    console.log('  USER ACCESS URLs (distribute only to end users):');
    for (const ip of candidates) {
      const url = buildUrl(ip, userSecret);
      console.log(`    ${url.padEnd(80)}  ${tag}`);
      console.log(`    Token: ${toBase64Token(url)}`);
    }
  }

  console.log('');
}
