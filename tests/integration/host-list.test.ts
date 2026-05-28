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
  VALID_REGISTRATION,
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
      sendMsg(host1, { ...VALID_REGISTRATION, modelName: 'model-a', port: 9001 });
      const ack1 = await readMsg(host1) as unknown as RegistrationAck;

      sendMsg(host2, { ...VALID_REGISTRATION, modelName: 'model-b', port: 9002,
        tlsFingerprint: 'sha256:' + 'b'.repeat(64) });
      const ack2 = await readMsg(host2) as unknown as RegistrationAck;

      // User connects and requests host list
      const userSock = await connectClient(router.port, router.fingerprint);
      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'host_list_request' });
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
        expect(typeof h.contextSize).toBe('number');
        expect(typeof h.endpoint).toBe('string');
        expect(typeof h.tlsFingerprint).toBe('string');
        expect(typeof h.hostKeyToken).toBe('string');
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
});
