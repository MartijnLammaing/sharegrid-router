/**
 * Key Authority — the router's Ed25519 trust anchor.
 *
 * Responsibilities (Phase 1):
 *  - Generate an Ed25519 keypair synchronously at construction; hold in memory only.
 *  - Issue signed host-key tokens on demand.
 *  - Validate inputs; throw on invalid arguments.
 *
 * The private key is never written to disk. A router restart generates a new
 * keypair, invalidating all previously issued tokens.
 *
 * See: docs/architecture_llmrouter.md §2.2, §4.1, §4.2
 *      docs/implementation_plan_llmrouter.md Phase 3A
 */

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { Logger } from 'pino';
import {
  signEd25519,
  encodeHostKeyToken,
} from '@sharegrid/shared/crypto';
import type { HostKeyTokenPayload } from '@sharegrid/shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyAuthorityDeps {
  logger: Logger;
}

export interface KeyAuthority {
  /** PEM-encoded SPKI public key — distributed to LLMHosts in RegistrationAck. */
  getPublicKey(): string;
  /** Role secret for host operators — validated on every registration connection. */
  getHostSecret(): string;
  /** Role secret for end users — validated on every host-list connection. */
  getUserSecret(): string;
  /**
   * Issue a signed host-key token.
   *
   * @param hostId          Identifier assigned to the host at registration.
   * @param tlsFingerprint  `sha256:<hex>` fingerprint of the host's TLS cert.
   * @param ttlMs           Token lifetime in milliseconds (must be > 0).
   * @throws {KeyAuthorityError} on invalid inputs.
   */
  issueHostKeyToken(hostId: string, tlsFingerprint: string, ttlMs: number): string;
}

/** Thrown by {@link KeyAuthority.issueHostKeyToken} on invalid inputs. */
export class KeyAuthorityError extends Error {
  readonly code = 'KEY_AUTHORITY_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'KeyAuthorityError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createKeyAuthority(deps: KeyAuthorityDeps): KeyAuthority {
  const { logger } = deps;
  const log = logger.child({ component: 'key-authority' });

  // Generate the keypair synchronously at construction — no async startup needed.
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    generateKeyPairSync('ed25519');

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  // Generate two independent role secrets. Neither is written to disk or logged.
  const hostSecret = randomBytes(32).toString('base64url');
  const userSecret = randomBytes(32).toString('base64url');

  log.info('Ed25519 keypair generated');

  return {
    getPublicKey(): string {
      return publicKeyPem;
    },

    getHostSecret(): string {
      return hostSecret;
    },

    getUserSecret(): string {
      return userSecret;
    },

    issueHostKeyToken(hostId: string, tlsFingerprint: string, ttlMs: number): string {
      if (typeof hostId !== 'string' || hostId.length === 0) {
        throw new KeyAuthorityError('hostId must be a non-empty string');
      }
      if (typeof tlsFingerprint !== 'string' || tlsFingerprint.length === 0) {
        throw new KeyAuthorityError('tlsFingerprint must be a non-empty string');
      }
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new KeyAuthorityError('ttlMs must be a positive finite number');
      }

      const payload: HostKeyTokenPayload = {
        hostId,
        tlsFingerprint,
        expiresAt: Date.now() + ttlMs,
      };

      // The signature is computed over the base64url-encoded payload string.
      // encodeHostKeyToken handles the encoding; we sign before calling it.
      const payloadJson = JSON.stringify(payload);
      const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
      const signature = signEd25519(privateKey, Buffer.from(payloadB64, 'utf8'));

      return encodeHostKeyToken(payload, signature);
    },
  };
}
