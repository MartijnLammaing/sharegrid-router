/**
 * Integration test — TLS cert persistence across restarts (6-5).
 *
 * The router must reuse its TLS cert and fingerprint across
 * docker stop/start cycles (i.e., when the process restarts but the
 * /data/certs directory is preserved). A full container recreation
 * (new cert dir) must produce a different fingerprint.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrGenerateCert } from '../../src/tls-cert-store.js';

describe('Router integration — TLS cert persistence', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeTempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'sgr-cert-test-'));
    tempDirs.push(d);
    return d;
  }

  it('fingerprint is identical on warm start (same cert directory)', () => {
    const certDir = makeTempDir();
    const certPath = join(certDir, 'router.crt');
    const keyPath  = join(certDir, 'router.key');

    // First start — generates cert
    const first = loadOrGenerateCert(certPath, keyPath);

    // Second start — loads existing cert
    const second = loadOrGenerateCert(certPath, keyPath);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.cert).toBe(first.cert);
  });

  it('fingerprint differs after the cert directory is deleted (full container recreation)', () => {
    const dir1 = makeTempDir();
    const first = loadOrGenerateCert(join(dir1, 'router.crt'), join(dir1, 'router.key'));

    // Delete and recreate — simulates container recreation
    rmSync(dir1, { recursive: true, force: true });
    tempDirs.splice(tempDirs.indexOf(dir1), 1);

    const dir2 = makeTempDir();
    const second = loadOrGenerateCert(join(dir2, 'router.crt'), join(dir2, 'router.key'));

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('creates the cert directory if it does not exist on first run', () => {
    const base = makeTempDir();
    const nested = join(base, 'nested', 'deep');
    const { fingerprint } = loadOrGenerateCert(
      join(nested, 'router.crt'),
      join(nested, 'router.key'),
    );
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
