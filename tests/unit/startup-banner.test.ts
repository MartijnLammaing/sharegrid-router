import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printStartupBanner } from '../../src/startup-banner.js';

describe('printStartupBanner', () => {
  let stdoutLines: string[] = [];

  beforeEach(() => {
    stdoutLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdoutLines.push(args.join(' '));
    });
    delete process.env['SHAREGRID_LAN_IPS'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SHAREGRID_LAN_IPS'];
  });

  const baseOpts = {
    listenAddr: '0.0.0.0:8443',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    hostSecret: 'host-secret-abc',
    userSecret: 'user-secret-xyz',
  };

  it('prints the fingerprint and listen address in the banner', () => {
    process.env['SHAREGRID_LAN_IPS'] = '192.168.1.10';
    printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('sha256:' + 'a'.repeat(64));
    expect(banner).toContain('LLMRouter started');
    expect(banner).toContain('0.0.0.0:8443');
  });

  it('prints two separate labelled URL blocks', () => {
    process.env['SHAREGRID_LAN_IPS'] = '192.168.1.10';
    printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('HOST REGISTRATION URLs');
    expect(banner).toContain('USER ACCESS URLs');
  });

  it('host URLs contain the host secret in the key param', () => {
    process.env['SHAREGRID_LAN_IPS'] = '192.168.1.10';
    printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    const hostBlock = banner.slice(
      banner.indexOf('HOST REGISTRATION URLs'),
      banner.indexOf('USER ACCESS URLs'),
    );
    expect(hostBlock).toContain('key=host-secret-abc');
    expect(hostBlock).not.toContain('key=user-secret-xyz');
  });

  it('user URLs contain the user secret in the key param', () => {
    process.env['SHAREGRID_LAN_IPS'] = '192.168.1.10';
    printStartupBanner(baseOpts);

    const banner = stdoutLines.join('\n');
    const userBlock = banner.slice(banner.indexOf('USER ACCESS URLs'));
    expect(userBlock).toContain('key=user-secret-xyz');
    expect(userBlock).not.toContain('key=host-secret-abc');
  });

  it('advertises the injected LAN IPv4 with the fingerprint', () => {
    process.env['SHAREGRID_LAN_IPS'] = '10.0.0.5';
    printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'b'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('fp=sha256:' + 'b'.repeat(64));
    expect(banner).toContain('10.0.0.5');
  });

  it('prints multiple injected LAN IPv4 addresses as candidates', () => {
    process.env['SHAREGRID_LAN_IPS'] = '192.168.1.10, 10.0.0.5';
    printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'c'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('192.168.1.10');
    expect(banner).toContain('10.0.0.5');
  });

  it('excludes loopback addresses from candidate endpoints', () => {
    process.env['SHAREGRID_LAN_IPS'] = '127.0.0.1, 192.168.1.10';
    printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'd'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).not.toContain('127.0.0.1:');
    expect(banner).toContain('192.168.1.10');
  });

  it('ignores non-IPv4 values in SHAREGRID_LAN_IPS', () => {
    process.env['SHAREGRID_LAN_IPS'] = 'not-an-ip, ::1, 256.0.0.1, 192.168.1.10';
    printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'e'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner).toContain('192.168.1.10');
    expect(banner).not.toContain('not-an-ip');
    expect(banner).not.toContain('256.0.0.1');
    expect(banner).not.toContain('[::1]');
  });

  it('prints a warning and falls back to the listen address when no LAN IP is provided', () => {
    printStartupBanner({ ...baseOpts, fingerprint: 'sha256:' + 'f'.repeat(64) });

    const banner = stdoutLines.join('\n');
    expect(banner.toUpperCase()).toContain('WARNING');
    expect(banner).toContain('0.0.0.0:8443');
  });
});
