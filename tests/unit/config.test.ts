import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from '@vitest/spy';

describe('loadConfig', () => {
  let exitSpy: MockInstance<(code?: number) => never>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null): never => {
        throw new Error('process.exit called');
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SHAREGRID_LISTEN_ADDR'];
    delete process.env['SHAREGRID_HEARTBEAT_TIMEOUT'];
  });

  async function load() {
    const { loadConfig } = await import('../../src/config.js');
    return loadConfig();
  }

  it('returns parsed config with defaults when all required fields are valid', async () => {
    process.env['SHAREGRID_LISTEN_ADDR'] = '0.0.0.0:8443';
    const config = await load();
    expect(config.SHAREGRID_LISTEN_ADDR).toBe('0.0.0.0:8443');
    expect(config.SHAREGRID_HEARTBEAT_TIMEOUT).toBe(90);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8443);
  });

  it('parses host and port correctly from listen addr', async () => {
    process.env['SHAREGRID_LISTEN_ADDR'] = 'localhost:9000';
    const config = await load();
    expect(config.host).toBe('localhost');
    expect(config.port).toBe(9000);
  });

  it('applies provided SHAREGRID_HEARTBEAT_TIMEOUT instead of default', async () => {
    process.env['SHAREGRID_LISTEN_ADDR'] = '0.0.0.0:8443';
    process.env['SHAREGRID_HEARTBEAT_TIMEOUT'] = '120';
    const config = await load();
    expect(config.SHAREGRID_HEARTBEAT_TIMEOUT).toBe(120);
  });

  it('defaults SHAREGRID_HEARTBEAT_TIMEOUT to 90 when not set', async () => {
    process.env['SHAREGRID_LISTEN_ADDR'] = '0.0.0.0:8443';
    delete process.env['SHAREGRID_HEARTBEAT_TIMEOUT'];
    const config = await load();
    expect(config.SHAREGRID_HEARTBEAT_TIMEOUT).toBe(90);
  });

  it('exits with code 1 when SHAREGRID_LISTEN_ADDR is missing', async () => {
    delete process.env['SHAREGRID_LISTEN_ADDR'];
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(['localhost', ':8443', 'nocolon', ''])(
    'exits with code 1 for malformed SHAREGRID_LISTEN_ADDR: "%s"',
    async (addr) => {
      process.env['SHAREGRID_LISTEN_ADDR'] = addr;
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it('coerces numeric SHAREGRID_HEARTBEAT_TIMEOUT string', async () => {
    process.env['SHAREGRID_LISTEN_ADDR'] = '0.0.0.0:8443';
    process.env['SHAREGRID_HEARTBEAT_TIMEOUT'] = '45';
    const config = await load();
    expect(config.SHAREGRID_HEARTBEAT_TIMEOUT).toBe(45);
  });
});
