import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import pino from 'pino';

// ── Mock node:tls ─────────────────────────────────────────────────────────────
let capturedConnectionCallback: ((sock: MockSocket) => void) | null = null;

vi.mock('node:tls', () => ({
  createServer: vi.fn(
    (_opts: unknown, callback: (sock: MockSocket) => void) => {
      capturedConnectionCallback = callback;
      return {
        listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); }),
        close: vi.fn((cb?: () => void) => { cb?.(); }),
        on: vi.fn(),
      };
    },
  ),
}));

import { createTlsListener } from '../../src/tls-listener.js';

// ── Mock socket ───────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;
  remoteAddress = '10.0.0.1';

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end() { this.destroyed = true; return this; }
  destroy() { this.destroyed = true; return this; }
  override once(event: string, fn: (...args: unknown[]) => void) { super.once(event, fn); return this; }

  inject(msg: object) { this.emit('data', JSON.stringify(msg) + '\n'); }

  messages(): Array<Record<string, unknown>> {
    return this.written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });
const baseConfig = {
  SHAREGRID_LISTEN_ADDR: '0.0.0.0:8443',
  SHAREGRID_NETWORK_MODE: 'lan' as const,
  SHAREGRID_HEARTBEAT_TIMEOUT: 90,
  host: '0.0.0.0',
  port: 8443,
};

const HOST_SECRET = 'mock-host-secret';
const USER_SECRET = 'mock-user-secret';

const mockKeyAuthority = {
  getPublicKey: vi.fn(() => 'mock-public-key-pem'),
  getHostSecret: vi.fn(() => HOST_SECRET),
  getUserSecret: vi.fn(() => USER_SECRET),
  issueHostKeyToken: vi.fn(() => 'mock-token'),
};

const mockHostRegistry = {
  add: vi.fn(),
  updateHeartbeat: vi.fn(() => true),
  list: vi.fn(() => []),
  evictStale: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

function makeListener() {
  return createTlsListener({
    config: baseConfig,
    logger,
    tlsCert: 'cert',
    tlsKey: 'key',
    keyAuthority: mockKeyAuthority,
    hostRegistry: mockHostRegistry,
  });
}

const validRegistration = {
  v: PROTOCOL_VERSION,
  type: 'register',
  modelName: 'test-model',
  port: 9000,
  tlsFingerprint: 'sha256:' + 'a'.repeat(64),
  listenHost: '192.168.1.42',
  roleKey: HOST_SECRET,
};

describe('TlsListener', () => {
  beforeEach(() => {
    capturedConnectionCallback = null;
    vi.clearAllMocks();
    mockKeyAuthority.issueHostKeyToken.mockReturnValue('mock-token');
    mockHostRegistry.updateHeartbeat.mockReturnValue(true);
  });

  async function startAndConnect() {
    const listener = makeListener();
    await listener.start();
    const sock = new MockSocket();
    capturedConnectionCallback!(sock);
    await new Promise((r) => setTimeout(r, 0));
    return { listener, sock };
  }

  describe('host registration', () => {
    it('valid registration triggers keyAuthority.issueHostKeyToken and hostRegistry.add', async () => {
      const { listener, sock } = await startAndConnect();

      sock.inject(validRegistration);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockKeyAuthority.issueHostKeyToken).toHaveBeenCalledWith(
        expect.any(String), // hostId
        validRegistration.tlsFingerprint,
        expect.any(Number), // ttlMs
      );
      expect(mockHostRegistry.add).toHaveBeenCalledOnce();
      const addedEntry = mockHostRegistry.add.mock.calls[0]![0] as Record<string, unknown>;
      expect(addedEntry['modelName']).toBe('test-model');
      expect(addedEntry['hostKeyToken']).toBe('mock-token');

      await listener.stop();
    });

    it('replies with RegistrationAck containing hostId, hostKeyToken, routerPublicKey', async () => {
      const { listener, sock } = await startAndConnect();

      sock.inject(validRegistration);
      await new Promise((r) => setTimeout(r, 10));

      const ack = sock.messages()[0]!;
      expect(ack['type']).toBe('register_ack');
      expect(ack['v']).toBe(PROTOCOL_VERSION);
      expect(typeof ack['hostId']).toBe('string');
      expect(ack['hostKeyToken']).toBe('mock-token');
      expect(ack['routerPublicKey']).toBe('mock-public-key-pem');

      await listener.stop();
    });

    it.each([
      ['modelName missing', { ...validRegistration, modelName: '' }],
      ['port out of range', { ...validRegistration, port: 0 }],
      ['tlsFingerprint invalid', { ...validRegistration, tlsFingerprint: 'invalid' }],
    ])('invalid registration field — %s — closes without adding to registry', async (_, payload) => {
      const { listener, sock } = await startAndConnect();

      sock.inject(payload);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.add).not.toHaveBeenCalled();
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });
  });

  describe('role key validation — host registration path', () => {
    it('missing roleKey closes socket without registry write', async () => {
      const { listener, sock } = await startAndConnect();
      const { roleKey: _omit, ...noKey } = validRegistration;
      void _omit;
      sock.inject(noKey);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.add).not.toHaveBeenCalled();
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });

    it('roleKey matching user secret (wrong role) closes socket without registry write', async () => {
      const { listener, sock } = await startAndConnect();
      sock.inject({ ...validRegistration, roleKey: USER_SECRET });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.add).not.toHaveBeenCalled();
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });

    it('correct host secret proceeds with registration normally', async () => {
      const { listener, sock } = await startAndConnect();
      sock.inject(validRegistration); // roleKey === HOST_SECRET
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.add).toHaveBeenCalledOnce();
      expect(sock.destroyed).toBe(false);

      await listener.stop();
    });
  });

  describe('user handshake', () => {
    it('host_list_request triggers hostRegistry.list and replies with HostListResponse', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHostRegistry.list.mockReturnValue([
        {
          hostId: 'h1', modelName: 'm',
          endpoint: '10.0.0.1:9000', tlsFingerprint: 'sha256:' + 'b'.repeat(64),
          hostKeyToken: 'tok',
        },
      ] as any);

      const { listener, sock } = await startAndConnect();
      sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: USER_SECRET });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.list).toHaveBeenCalled();
      const response = sock.messages()[0]!;
      expect(response['type']).toBe('host_list_response');
      expect(Array.isArray(response['hosts'])).toBe(true);
      expect((response['hosts'] as unknown[]).length).toBe(1);

      // Router closes the connection after replying
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });
  });

  describe('role key validation — user handshake path', () => {
    it('missing roleKey closes socket without sending host list', async () => {
      const { listener, sock } = await startAndConnect();
      sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_request' });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.list).not.toHaveBeenCalled();
      expect(sock.messages()).toHaveLength(0);
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });

    it('roleKey matching host secret (wrong role) closes socket', async () => {
      const { listener, sock } = await startAndConnect();
      sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: HOST_SECRET });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.list).not.toHaveBeenCalled();
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });

    it('correct user secret returns the host list', async () => {
      mockHostRegistry.list.mockReturnValue([]);
      const { listener, sock } = await startAndConnect();
      sock.inject({ v: PROTOCOL_VERSION, type: 'host_list_request', roleKey: USER_SECRET });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockHostRegistry.list).toHaveBeenCalled();
      expect(sock.messages()[0]!['type']).toBe('host_list_response');

      await listener.stop();
    });
  });

  describe('demux — unknown initial message', () => {
    it('closes the socket with no response for an unknown initial type', async () => {
      const { listener, sock } = await startAndConnect();
      sock.inject({ v: PROTOCOL_VERSION, type: 'unknown_type_xyz' });
      await new Promise((r) => setTimeout(r, 10));

      expect(sock.messages()).toHaveLength(0);
      expect(sock.destroyed).toBe(true);

      await listener.stop();
    });
  });
});
