/**
 * Integration test — host list returned to a LLMUser (6-3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type RegistrationAck, type HostListResponse } from '@sharegrid/shared/protocol';
import {
  startTestRouter,
  connectClient,
  sendMsg,
  readMsg,
  makeValidRegistration,
  type TestRouter,
} from './helpers.js';

describe('Router integration — host list', () => {
  let router: TestRouter;

  beforeEach(async () => {
    router = await startTestRouter();
  });

  afterEach(async () => {
    await router.teardown();
  });

  it('returns HostListResponse with registered hosts and closes the connection', async () => {
    // Register two hosts
    const host1 = await connectClient(router.port, router.fingerprint);
    const host2 = await connectClient(router.port, router.fingerprint);

    try {
      sendMsg(host1, { ...makeValidRegistration(router.hostSecret), modelName: 'model-a', port: 9001 });
      const ack1 = await readMsg(host1) as unknown as RegistrationAck;

      sendMsg(host2, {
        ...makeValidRegistration(router.hostSecret),
        modelName: 'model-b',
        port: 9002,
        tlsFingerprint: 'sha256:' + 'b'.repeat(64),
      });
      const ack2 = await readMsg(host2) as unknown as RegistrationAck;

      // User connects and requests host list with correct user secret
      const userSock = await connectClient(router.port, router.fingerprint);
      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: router.userSecret });
      const response = await readMsg(userSock) as unknown as HostListResponse;

      expect(response.type).toBe('host_list_response');
      expect(response.hosts).toHaveLength(2);

      const ids = response.hosts.map((h) => h.hostId);
      expect(ids).toContain(ack1.hostId);
      expect(ids).toContain(ack2.hostId);

      // All wire fields must be present
      for (const h of response.hosts) {
        expect(typeof h.hostId).toBe('string');
        expect(typeof h.modelName).toBe('string');
        expect(typeof h.endpoint).toBe('string');
        expect(typeof h.tlsFingerprint).toBe('string');
        expect(typeof h.hostKeyToken).toBe('string');
        // Phase 3 availability fields
        expect(typeof h.contextSize).toBe('number');
        expect(typeof h.availableSlots).toBe('number');
        expect(typeof h.totalSlots).toBe('number');
        // lastSeen must NOT be exposed to users
        expect(Object.keys(h)).not.toContain('lastSeen');
      }

      // Router closes the user connection after the reply
      await new Promise<void>((resolve) => {
        if (userSock.destroyed) { resolve(); return; }
        userSock.once('close', () => resolve());
        setTimeout(resolve, 1000); // fallback
      });
      expect(userSock.destroyed).toBe(true);

      host1.destroy();
      host2.destroy();
    } finally {
      host1.destroy();
      host2.destroy();
    }
  });

  it('host list request rejected when roleKey is missing — socket closed, no host list sent', async () => {
    const userSock = await connectClient(router.port, router.fingerprint);
    sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'host_list_request' /* no roleKey */ });

    // Wait for 'close' (not 'end'): 'end' fires when the FIN arrives but the
    // socket is not yet destroyed, so asserting on it races the teardown.
    await new Promise<void>((resolve) => {
      if (userSock.destroyed) { resolve(); return; }
      userSock.once('close', () => resolve());
      setTimeout(resolve, 1_000);
    });

    expect(userSock.destroyed).toBe(true);
    userSock.destroy();
  });

  it('host list request rejected when roleKey is the host secret (wrong role)', async () => {
    const userSock = await connectClient(router.port, router.fingerprint);
    sendMsg(userSock, {
      v: PROTOCOL_VERSION,
      type: 'host_list_request',
      roleKey: router.hostSecret, // wrong role
    });

    // Wait for 'close' (not 'end'): 'end' fires when the FIN arrives but the
    // socket is not yet destroyed, so asserting on it races the teardown.
    await new Promise<void>((resolve) => {
      if (userSock.destroyed) { resolve(); return; }
      userSock.once('close', () => resolve());
      setTimeout(resolve, 1_000);
    });

    expect(userSock.destroyed).toBe(true);
    userSock.destroy();
  });

  // ── Phase 3: host_status_update → availability in host list ───────────────

  it('host_status_update is reflected as availableSlots in the host list', async () => {
    const hostSock = await connectClient(router.port, router.fingerprint);
    try {
      // Register with maxSessions: 2 (activeSessions starts at 0)
      sendMsg(hostSock, { ...makeValidRegistration(router.hostSecret), maxSessions: 2 });
      const ack = await readMsg(hostSock) as unknown as RegistrationAck;
      const hostId = ack.hostId;

      // A status update with activeSessions: 1 → user should see availableSlots: 1
      sendMsg(hostSock, { v: PROTOCOL_VERSION, type: 'host_status_update', hostId, activeSessions: 1 });
      await new Promise((r) => setTimeout(r, 20));

      const userSock1 = await connectClient(router.port, router.fingerprint);
      sendMsg(userSock1, { v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: router.userSecret });
      const response1 = await readMsg(userSock1) as unknown as HostListResponse;
      userSock1.destroy();

      const entry1 = response1.hosts.find((h) => h.hostId === hostId)!;
      expect(entry1).toBeDefined();
      expect(entry1.totalSlots).toBe(2);
      expect(entry1.availableSlots).toBe(1);

      // A status update with activeSessions: 2 → user should see availableSlots: 0
      sendMsg(hostSock, { v: PROTOCOL_VERSION, type: 'host_status_update', hostId, activeSessions: 2 });
      await new Promise((r) => setTimeout(r, 20));

      const userSock2 = await connectClient(router.port, router.fingerprint);
      sendMsg(userSock2, { v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: router.userSecret });
      const response2 = await readMsg(userSock2) as unknown as HostListResponse;
      userSock2.destroy();

      const entry2 = response2.hosts.find((h) => h.hostId === hostId)!;
      expect(entry2).toBeDefined();
      expect(entry2.availableSlots).toBe(0);
    } finally {
      hostSock.destroy();
    }
  });
});
