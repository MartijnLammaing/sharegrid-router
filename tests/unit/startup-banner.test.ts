import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printStartupBanner } from '../../src/startup-banner.js';

// ── Mock node:os ──────────────────────────────────────────────────────────────
const { mockNetworkInterfaces } = vi.hoisted(() => ({ mockNetworkInterfaces: vi.fn() }));
vi.mock('node:os', () => ({
  networkInterfaces: mockNetworkInterfaces,
}));

// ── Mock global fetch ─────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('printStartupBanner', () => {
  let stdoutLines: string[] = [];

  beforeEach(() => {
    stdoutLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdoutLines.push(args.join(' '));
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseOpts = {
    listenAddr: '0.0.0.0:8443',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    hostSecret: 'host-secret-abc',
    userSecret: 'user-secret-xyz',
  };

  it('prints the fingerprint in the banner', async () => {
    mockNetworkInterfaces.mockReturnValue({});
    mockFetch.mockRejectedValueOnce(new Error('network unreachable'));

    await printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('sha256:' + 'a'.repeat(64));
    expect(banner).toContain('LLMRouter started');
    expect(banner).toContain('0.0.0.0:8443');
  });

  it('prints two separate labelled URL blocks', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('HOST REGISTRATION URLs');
    expect(banner).toContain('USER ACCESS URLs');
  });

  it('host URLs contain the host secret in the key param', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    // Find all lines under HOST REGISTRATION URLs block
    const hostBlock = banner.slice(
      banner.indexOf('HOST REGISTRATION URLs'),
      banner.indexOf('USER ACCESS URLs'),
    );
    expect(hostBlock).toContain('key=host-secret-abc');
    expect(hostBlock).not.toContain('key=user-secret-xyz');
  });

  it('user URLs contain the user secret in the key param', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    const userBlock = banner.slice(banner.indexOf('USER ACCESS URLs'));
    expect(userBlock).toContain('key=user-secret-xyz');
    expect(userBlock).not.toContain('key=host-secret-abc');
  });

  it('both URL sets contain the fingerprint and exclude loopback', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'b'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('fp=sha256:' + 'b'.repeat(64));
    expect(banner).toContain('10.0.0.5');
    expect(banner).not.toContain('127.0.0.1:');
  });

  it('prints non-loopback IPv4 interfaces as candidate endpoints', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'c'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('192.168.1.10');
    expect(banner).not.toContain('127.0.0.1');
  });

  it('excludes loopback addresses from candidate endpoints', async () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'd'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).not.toContain('127.0.0.1:');
  });

  it('handles public IP lookup timeout gracefully (non-fatal)', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
    });

    // Simulate AbortError (timeout)
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    // Should not throw
    await expect(
      printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'e'.repeat(64) }),
    ).resolves.toBeUndefined();

    const banner = stdoutLines.join('\n');
    // eth0 still appears
    expect(banner).toContain('10.0.0.1');
  });

  it('prints warning when no non-loopback interfaces are found', async () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('network unavailable'));

    await printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'f'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner.toUpperCase()).toContain('WARNING');
  });

  it('includes public IP candidate when lookup succeeds', async () => {
    mockNetworkInterfaces.mockReturnValue({});
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('203.0.113.7'),
    });

    await printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('203.0.113.7');
    expect(banner).toContain('[public]');
  });
});
