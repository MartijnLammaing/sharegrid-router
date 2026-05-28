import { describe, expect, it } from 'vitest';
import { createKeyAuthority, KeyAuthorityError } from '../../src/key-authority.js';
import { decodeHostKeyToken } from '@sharegrid/shared/crypto';
import { verifyEd25519 } from '@sharegrid/shared/crypto';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const VALID_FINGERPRINT = 'sha256:' + 'a'.repeat(64);

function makeKa() {
  return createKeyAuthority({ logger });
}

describe('KeyAuthority', () => {
  describe('getPublicKey', () => {
    it('returns a PEM-formatted SPKI public key string', () => {
      const ka = makeKa();
      const pem = ka.getPublicKey();
      expect(pem).toMatch(/-----BEGIN PUBLIC KEY-----/);
      expect(pem).toMatch(/-----END PUBLIC KEY-----/);
    });

    it('returns the same key on repeated calls', () => {
      const ka = makeKa();
      expect(ka.getPublicKey()).toBe(ka.getPublicKey());
    });
  });

  describe('issueHostKeyToken', () => {
    it('produces a token that round-trips through decodeHostKeyToken', () => {
      const ka = makeKa();
      const token = ka.issueHostKeyToken('host-1', VALID_FINGERPRINT, 60_000);
      const decoded = decodeHostKeyToken(token);
      expect(decoded.payload.hostId).toBe('host-1');
      expect(decoded.payload.tlsFingerprint).toBe(VALID_FINGERPRINT);
      expect(decoded.payload.expiresAt).toBeGreaterThan(Date.now());
    });

    it('produces a token whose Ed25519 signature verifies against the public key', () => {
      const ka = makeKa();
      const token = ka.issueHostKeyToken('host-1', VALID_FINGERPRINT, 60_000);
      const decoded = decodeHostKeyToken(token);
      const ok = verifyEd25519(
        ka.getPublicKey(),
        Buffer.from(decoded.payloadB64, 'utf8'),
        decoded.signature,
      );
      expect(ok).toBe(true);
    });

    it('sets expiresAt ≈ now + ttlMs', () => {
      const ka = makeKa();
      const before = Date.now();
      const token = ka.issueHostKeyToken('host-1', VALID_FINGERPRINT, 90_000);
      const after = Date.now();
      const { expiresAt } = decodeHostKeyToken(token).payload;
      expect(expiresAt).toBeGreaterThanOrEqual(before + 90_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 90_000 + 5);
    });

    it('two tokens for the same inputs differ only in expiresAt (due to timing)', async () => {
      const ka = makeKa();
      await new Promise((r) => setTimeout(r, 2)); // ensure time advances
      const t1 = decodeHostKeyToken(ka.issueHostKeyToken('host-1', VALID_FINGERPRINT, 60_000));
      await new Promise((r) => setTimeout(r, 2));
      const t2 = decodeHostKeyToken(ka.issueHostKeyToken('host-1', VALID_FINGERPRINT, 60_000));
      expect(t1.payload.hostId).toBe(t2.payload.hostId);
      expect(t1.payload.tlsFingerprint).toBe(t2.payload.tlsFingerprint);
      // expiresAt will differ because time passed between calls
      expect(t1.payload.expiresAt).not.toBe(t2.payload.expiresAt);
    });

    it.each([
      ['empty hostId', '', VALID_FINGERPRINT, 60_000],
      ['empty fingerprint', 'host-1', '', 60_000],
      ['zero ttlMs', 'host-1', VALID_FINGERPRINT, 0],
      ['negative ttlMs', 'host-1', VALID_FINGERPRINT, -1],
    ] as const)('throws KeyAuthorityError for invalid input: %s', (_label, hostId, fp, ttl) => {
      const ka = makeKa();
      expect(() => ka.issueHostKeyToken(hostId, fp, ttl)).toThrow(KeyAuthorityError);
    });
  });
});
