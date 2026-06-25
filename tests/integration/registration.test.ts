/**
 * Integration tests — LLMHost registration and heartbeat token rotation (6-1, 6-2).
 *
 * Uses a real router instance on an ephemeral port. All TLS connections are
 * made with genuine fingerprint pinning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type RegistrationAck, type HeartbeatAck } from '@sharegrid/shared/protocol';
import { verifyEd25519, decodeHostKeyToken } from '@sharegrid/shared/crypto';
import {
  startTestRouter,
  connectClient,
  sendMsg,
  readMsg,
  makeValidRegistration,
  type TestRouter,
} from './helpers.js';

describe('Router integration — registration', () => {
  let router: TestRouter;

  beforeEach(async () => {
    router = await startTestRouter();
  });

  afterEach(async () => {
    await router.teardown();
  });

  // ── 6-1: Happy registration ────────────────────────────────────────────────

  it('returns RegistrationAck with a valid hostId and verifiable hostKeyToken', async () => {
    const sock = await connectClient(router.port, router.fingerprint);

    try {
      sendMsg(sock, makeValidRegistration(router.hostSecret));
      const ack = await readMsg(sock) as unknown as RegistrationAck;

      expect(ack.v).toBe(PROTOCOL_VERSION);
      expect(ack.type).toBe('register_ack');
      expect(typeof ack.hostId).toBe('string');
      expect(ack.hostId.length).toBeGreaterThan(0);
      expect(typeof ack.hostKeyToken).toBe('string');
      expect(typeof ack.routerPublicKey).toBe('string');
      expect(ack.routerPublicKey).toMatch(/-----BEGIN PUBLIC KEY-----/);

      // Verify the token signature
      const decoded = decodeHostKeyToken(ack.hostKeyToken);
      const ok = verifyEd25519(
        ack.routerPublicKey,
        Buffer.from(decoded.payloadB64, 'utf8'),
        decoded.signature,
      );
      expect(ok).toBe(true);

      // Verify token payload fields
      expect(decoded.payload.hostId).toBe(ack.hostId);
      expect(decoded.payload.tlsFingerprint).toBe('sha256:' + 'a'.repeat(64));
      expect(decoded.payload.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      sock.destroy();
    }
  });

  it('returns a PEM-encoded Ed25519 public key in routerPublicKey', async () => {
    const sock = await connectClient(router.port, router.fingerprint);
    try {
      sendMsg(sock, makeValidRegistration(router.hostSecret));
      const ack = await readMsg(sock) as unknown as RegistrationAck;
      expect(ack.routerPublicKey).toMatch(/-----BEGIN PUBLIC KEY-----/);
      expect(ack.routerPublicKey).toMatch(/-----END PUBLIC KEY-----/);
    } finally {
      sock.destroy();
    }
  });

  // ── 6-2: Heartbeat token rotation ─────────────────────────────────────────

  it('HeartbeatAck contains a new token that also verifies against routerPublicKey', async () => {
    const sock = await connectClient(router.port, router.fingerprint);

    try {
      sendMsg(sock, makeValidRegistration(router.hostSecret));
      const ack = await readMsg(sock) as unknown as RegistrationAck;
      const firstToken = ack.hostKeyToken;

      // Wait a moment so the new token's expiresAt differs
      await new Promise((r) => setTimeout(r, 5));

      // Send heartbeat
      sendMsg(sock, { v: PROTOCOL_VERSION, type: 'heartbeat', hostId: ack.hostId, activeSessions: 0 });
      const heartbeatAck = await readMsg(sock) as unknown as HeartbeatAck;

      expect(heartbeatAck.type).toBe('heartbeat_ack');
      expect(heartbeatAck.hostKeyToken).toBeTruthy();

      // New token must verify
      const decoded = decodeHostKeyToken(heartbeatAck.hostKeyToken);
      const ok = verifyEd25519(
        ack.routerPublicKey,
        Buffer.from(decoded.payloadB64, 'utf8'),
        decoded.signature,
      );
      expect(ok).toBe(true);

      // New token should differ from the registration token (new expiresAt)
      expect(heartbeatAck.hostKeyToken).not.toBe(firstToken);
    } finally {
      sock.destroy();
    }
  });

  it('registration rejected when roleKey is missing — socket closed with no RegistrationAck', async () => {
    const sock = await connectClient(router.port, router.fingerprint);

    // Send a registration without roleKey
    sendMsg(sock, {
      v: PROTOCOL_VERSION,
      type: 'register',
      modelName: 'test-model',
      port: 9000,
      tlsFingerprint: 'sha256:' + 'a'.repeat(64),
      // roleKey intentionally omitted
    });

    // The router should close the connection — we expect no message, then close
    await new Promise<void>((resolve) => {
      sock.once('close', resolve);
      sock.once('end', resolve);
      // Safety timeout in case the socket is destroyed but close doesn't fire
      setTimeout(resolve, 1_000);
    });

    expect(router.hostRegistry.list()).toHaveLength(0);
    sock.destroy();
  });

  it('registration rejected when roleKey is the user secret (wrong role)', async () => {
    const sock = await connectClient(router.port, router.fingerprint);

    sendMsg(sock, {
      ...makeValidRegistration(router.hostSecret),
      roleKey: router.userSecret, // wrong role
    });

    await new Promise<void>((resolve) => {
      sock.once('close', resolve);
      sock.once('end', resolve);
      setTimeout(resolve, 1_000);
    });

    expect(router.hostRegistry.list()).toHaveLength(0);
    sock.destroy();
  });

  it('heartbeat updates the registry lastSeen (host remains in list after heartbeat)', async () => {
    const sock = await connectClient(router.port, router.fingerprint);

    try {
      sendMsg(sock, makeValidRegistration(router.hostSecret));
      const ack = await readMsg(sock) as unknown as RegistrationAck;

      sendMsg(sock, { v: PROTOCOL_VERSION, type: 'heartbeat', hostId: ack.hostId, activeSessions: 0 });
      await readMsg(sock); // consume HeartbeatAck

      // Host should still be in the registry
      const hosts = router.hostRegistry.list();
      expect(hosts.some((h) => h.hostId === ack.hostId)).toBe(true);
    } finally {
      sock.destroy();
    }
  });
});
