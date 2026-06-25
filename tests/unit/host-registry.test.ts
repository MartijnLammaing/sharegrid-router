import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostRegistry, type HostEntry } from '../../src/host-registry.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeConfig(heartbeatTimeout = 90) {
  return {
    SHAREGRID_LISTEN_ADDR: '0.0.0.0:8443',
    SHAREGRID_NETWORK_MODE: 'lan' as const,
    SHAREGRID_HEARTBEAT_TIMEOUT: heartbeatTimeout,
    host: '0.0.0.0',
    port: 8443,
  };
}

function makeEntry(overrides: Partial<HostEntry> = {}): HostEntry {
  return {
    hostId: 'host-1',
    modelName: 'test-model',
    endpoint: '10.0.0.1:9000',
    tlsFingerprint: 'sha256:' + 'a'.repeat(64),
    hostKeyToken: 'token-1',
    contextSize: 4096,
    maxSessions: 4,
    activeSessions: 0,
    lastSeen: Date.now(),
    ...overrides,
  };
}

describe('HostRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('add and list', () => {
    it('add then list returns the entry projected to HostListEntry shape', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1', hostKeyToken: 'tok-1' }));
      const list = reg.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.hostId).toBe('host-1');
      expect(list[0]!.hostKeyToken).toBe('tok-1');
      expect(list[0]!.contextSize).toBe(4096);
      expect(list[0]!.totalSlots).toBe(4);
      expect(list[0]!.availableSlots).toBe(4);
      // lastSeen must NOT appear in the wire-format list
      expect(Object.keys(list[0]!)).not.toContain('lastSeen');
    });

    it('lists multiple entries', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1' }));
      reg.add(makeEntry({ hostId: 'host-2' }));
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe('updateHeartbeat', () => {
    it('updates lastSeen, replaces hostKeyToken, and stores activeSessions', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      const entry = makeEntry({ lastSeen: 1000, hostKeyToken: 'old-token', activeSessions: 0 });
      reg.add(entry);

      const now = 2000;
      const result = reg.updateHeartbeat('host-1', 'new-token', 2, now);

      expect(result).toBe(true);
      // Verify via list — new token and activeSessions should be reflected
      expect(reg.list()[0]!.hostKeyToken).toBe('new-token');
      expect(reg.list()[0]!.availableSlots).toBe(2); // maxSessions 4 - activeSessions 2
    });

    it('returns false for an unknown hostId', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      expect(reg.updateHeartbeat('unknown-host', 'tok', 0, Date.now())).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('updates activeSessions and returns true', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1', maxSessions: 4, activeSessions: 0 }));

      const result = reg.updateStatus('host-1', 3);

      expect(result).toBe(true);
      expect(reg.list()[0]!.availableSlots).toBe(1); // 4 - 3
    });

    it('does NOT update lastSeen (status updates are not heartbeats)', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1', lastSeen: 1000, activeSessions: 0 }));

      reg.updateStatus('host-1', 2);

      // The entry should still be evictable based on the original lastSeen.
      // Advance time well past the heartbeat timeout; the host should be evicted
      // even though a status update just succeeded.
      const evicted = reg.evictStale(1000 + 91_000);
      expect(evicted).toEqual(['host-1']);
    });

    it('returns false for an unknown hostId', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      expect(reg.updateStatus('unknown-host', 1)).toBe(false);
    });
  });

  describe('list — availability computation', () => {
    it('computes availableSlots = maxSessions - activeSessions', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'h', maxSessions: 2, activeSessions: 1, contextSize: 8192 }));
      const entry = reg.list()[0]!;
      expect(entry.availableSlots).toBe(1);
      expect(entry.totalSlots).toBe(2);
      expect(entry.contextSize).toBe(8192);
    });

    it('full host (activeSessions === maxSessions) → availableSlots: 0', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'h', maxSessions: 2, activeSessions: 2 }));
      expect(reg.list()[0]!.availableSlots).toBe(0);
    });

    it('over-full host (activeSessions > maxSessions) → availableSlots clamped to 0', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'h', maxSessions: 2, activeSessions: 5 }));
      expect(reg.list()[0]!.availableSlots).toBe(0);
    });
  });

  describe('remove', () => {
    it('removes an existing host from the registry', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1' }));
      reg.add(makeEntry({ hostId: 'host-2' }));

      reg.remove('host-1');

      expect(reg.list().map((h) => h.hostId)).toEqual(['host-2']);
    });

    it('is a no-op for an unknown hostId', () => {
      const reg = createHostRegistry({ config: makeConfig(), logger });
      reg.add(makeEntry({ hostId: 'host-1' }));

      expect(() => reg.remove('unknown')).not.toThrow();
      expect(reg.list()).toHaveLength(1);
    });
  });

  describe('evictStale', () => {
    it('removes hosts whose lastSeen exceeds the heartbeat timeout', () => {
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      const now = 100_000;
      reg.add(makeEntry({ hostId: 'stale', lastSeen: now - 91_000 }));
      reg.add(makeEntry({ hostId: 'fresh', lastSeen: now - 10_000 }));

      const evicted = reg.evictStale(now);
      expect(evicted).toEqual(['stale']);
      expect(reg.list().map((h) => h.hostId)).toEqual(['fresh']);
    });

    it('keeps hosts whose lastSeen is exactly at the timeout boundary', () => {
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      const now = 100_000;
      // exactly at the timeout — not yet stale (cutoff is strict <)
      reg.add(makeEntry({ hostId: 'boundary', lastSeen: now - 90_000 }));

      const evicted = reg.evictStale(now);
      expect(evicted).toHaveLength(0);
      expect(reg.list()).toHaveLength(1);
    });

    it.each([
      { label: 'one ms before cutoff', offset: 89_999, expectEvicted: false },
      { label: 'at cutoff', offset: 90_000, expectEvicted: false },
      { label: 'one ms past cutoff', offset: 90_001, expectEvicted: true },
    ])('boundary: lastSeen $label → evicted: $expectEvicted', ({ offset, expectEvicted }) => {
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      const now = 200_000;
      reg.add(makeEntry({ lastSeen: now - offset }));

      const evicted = reg.evictStale(now);
      expect(evicted.length > 0).toBe(expectEvicted);
    });

    it('returns empty array when nothing is stale', () => {
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      reg.add(makeEntry({ lastSeen: Date.now() }));
      expect(reg.evictStale(Date.now())).toHaveLength(0);
    });
  });

  describe('start / stop — background eviction loop', () => {
    it('automatically evicts stale hosts after the eviction interval', () => {
      const timeoutMs = 90_000;
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      reg.start();

      // Add a host that will become stale after the timeout
      reg.add(makeEntry({ hostId: 'will-evict', lastSeen: Date.now() - timeoutMs - 1 }));
      expect(reg.list()).toHaveLength(1);

      // Advance by evictionInterval (= timeout / 3 = 30s)
      vi.advanceTimersByTime(30_001);

      expect(reg.list()).toHaveLength(0);
      reg.stop();
    });

    it('stop clears the eviction interval', () => {
      const reg = createHostRegistry({ config: makeConfig(90), logger });
      reg.start();
      reg.stop();
      // No timer should be active after stop
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
