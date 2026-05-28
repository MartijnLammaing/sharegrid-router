/**
 * Integration test — heartbeat timeout eviction (6-4).
 *
 * Uses a very short heartbeat timeout (3 s) so the test completes quickly.
 * A registered host that stops sending heartbeats should be evicted and
 * absent from subsequent HostListResponse messages.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type RegistrationAck, type HostListResponse } from '@sharegrid/shared/protocol';
import {
  startTestRouter,
  connectClient,
  sendMsg,
  readMsg,
  VALID_REGISTRATION,
  type TestRouter,
} from './helpers.js';

describe('Router integration — eviction', () => {
  let router: TestRouter;

  beforeEach(async () => {
    // 3-second heartbeat timeout so eviction happens quickly in the test
    router = await startTestRouter(3);
  });

  afterEach(async () => {
    await router.teardown();
  });

  it('evicts a host that stops heartbeating after the timeout', async () => {
    const hostSock = await connectClient(router.port, router.fingerprint);

    try {
      sendMsg(hostSock, VALID_REGISTRATION);
      const ack = await readMsg(hostSock) as unknown as RegistrationAck;
      const hostId = ack.hostId;

      // Host is in the list immediately after registration
      expect(router.hostRegistry.list().some((h) => h.hostId === hostId)).toBe(true);

      // Stop sending heartbeats — just close the connection and wait
      hostSock.destroy();

      // Wait for the timeout + one eviction cycle (3s + 1s buffer)
      await new Promise((r) => setTimeout(r, 4_500));

      // The host should have been evicted
      const remaining = router.hostRegistry.list().map((h) => h.hostId);
      expect(remaining).not.toContain(hostId);

      // Verify via a user fetching the list
      const userSock = await connectClient(router.port, router.fingerprint);
      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'host_list_request' });
      const response = await readMsg(userSock) as unknown as HostListResponse;
      userSock.destroy();

      const listedIds = response.hosts.map((h) => h.hostId);
      expect(listedIds).not.toContain(hostId);
    } finally {
      hostSock.destroy();
    }
  }, 10_000); // extended timeout for the real eviction wait
});
