import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrGenerateCert } from '../../src/tls-cert-store.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `sharegrid-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadOrGenerateCert', () => {
  let tempDir: string;
  let certPath: string;
  let keyPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    certPath = join(tempDir, 'router.crt');
    keyPath = join(tempDir, 'router.key');
  });

  afterEach(() => {
    // temp directory is cleaned up by the OS eventually; no explicit removal needed in tests
  });

  it('generates cert and key files on first run (cold start)', () => {
    const bundle = loadOrGenerateCert(certPath, keyPath);

    expect(existsSync(certPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
    expect(bundle.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(bundle.key).toMatch(/-----BEGIN/);
    expect(bundle.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('writes cert and key files with mode 0600', () => {
    loadOrGenerateCert(certPath, keyPath);

    const certMode = statSync(certPath).mode & 0o777;
    const keyMode = statSync(keyPath).mode & 0o777;
    expect(certMode).toBe(0o600);
    expect(keyMode).toBe(0o600);
  });

  it('reads existing files and returns the same fingerprint on second run (warm start)', () => {
    const first = loadOrGenerateCert(certPath, keyPath);
    const second = loadOrGenerateCert(certPath, keyPath);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it('returns a fingerprint with sha256: prefix and 64-hex-char suffix', () => {
    const { fingerprint } = loadOrGenerateCert(certPath, keyPath);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('creates the cert directory if it does not exist', () => {
    const nestedCertPath = join(tempDir, 'nested', 'deep', 'router.crt');
    const nestedKeyPath = join(tempDir, 'nested', 'deep', 'router.key');

    const bundle = loadOrGenerateCert(nestedCertPath, nestedKeyPath);
    expect(bundle.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(nestedCertPath)).toBe(true);
  });

  it('throws when the cert directory is unwritable', () => {
    // Write a regular file at the path where the directory should be created,
    // making mkdirSync fail.
    const blockerPath = join(tempDir, 'blocker');
    writeFileSync(blockerPath, 'block');
    const blockedCertPath = join(blockerPath, 'router.crt');
    const blockedKeyPath = join(blockerPath, 'router.key');

    expect(() => loadOrGenerateCert(blockedCertPath, blockedKeyPath)).toThrow();
  });
});
