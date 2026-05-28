import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock node:os ──────────────────────────────────────────────────────────────
const mockNetworkInterfaces = vi.fn();
vi.mock('node:os', () => ({
  networkInterfaces: mockNetworkInterfaces,
}));

// ── Mock global fetch ─────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { printStartupBanner } = await import('../../src/startup-banner.js');

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

  it('prints the fingerprint in the banner', async () => {
    mockNetworkInterfaces.mockReturnValue({});
    mockFetch.mockRejectedValueOnce(new Error('network unreachable'));

    await printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'a'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('sha256:' + 'a'.repeat(64));
    expect(banner).toContain('LLMRouter started');
    expect(banner).toContain('0.0.0.0:8443');
  });

  it('prints non-loopback IPv4 interfaces as candidate endpoints', async () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'b'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('192.168.1.10');
    expect(banner).not.toContain('127.0.0.1');
  });

  it('excludes loopback addresses from candidate endpoints', async () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    await printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'c'.repeat(64) });

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
      printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'd'.repeat(64) }),
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

    await printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'e'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner.toUpperCase()).toContain('WARNING');
  });

  it('includes public IP candidate when lookup succeeds', async () => {
    mockNetworkInterfaces.mockReturnValue({});
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('203.0.113.7'),
    });

    await printStartupBanner({ listenAddr: '0.0.0.0:8443', fingerprint: 'sha256:' + 'f'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('203.0.113.7');
    expect(banner).toContain('[public]');
  });
});
