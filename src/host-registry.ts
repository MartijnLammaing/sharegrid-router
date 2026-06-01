/**
 * Host Registry — in-memory map of active LLMHosts with background eviction.
 *
 * Each entry is added on registration and evicted when its `lastSeen`
 * timestamp exceeds the configured heartbeat timeout. The registry always
 * holds only the *current* token per host; the LLMHost maintains the overlap
 * window on its side.
 *
 * See: docs/architecture_llmrouter.md §2.3
 *      docs/implementation_plan_llmrouter.md Phase 3B
 */

import type { Logger } from 'pino';
import type { HostListEntry } from '@sharegrid/shared/protocol';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal representation of a registered host.
 * `lastSeen` is router-internal and is never sent to LLMUsers.
 */
export interface HostEntry {
  hostId: string;
  modelName: string;
  /** `host:port` the user connects to directly. */
  endpoint: string;
  /** `sha256:<hex>` TLS cert fingerprint for user cert pinning. */
  tlsFingerprint: string;
  /** Current signed token issued by the Key Authority. */
  hostKeyToken: string;
  /** Unix epoch milliseconds of the most recent heartbeat (or registration). */
  lastSeen: number;
}

export interface HostRegistryDeps {
  config: Config;
  logger: Logger;
}

export interface HostRegistry {
  add(entry: HostEntry): void;
  /**
   * Update `lastSeen` and replace `hostKeyToken` for an existing host.
   * Returns `false` if the host is unknown (caller treats this as an error).
   */
  updateHeartbeat(hostId: string, newToken: string, now: number): boolean;
  /** All non-evicted entries projected to the wire-format shape. */
  list(): HostListEntry[];
  /**
   * Remove entries whose `lastSeen` is older than `now - heartbeatTimeoutMs`.
   * Returns the list of evicted `hostId`s for logging.
   */
  evictStale(now: number): string[];
  /** Start the background eviction loop. */
  start(): void;
  /** Stop the background eviction loop. */
  stop(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createHostRegistry(deps: HostRegistryDeps): HostRegistry {
  const { config, logger } = deps;
  const log = logger.child({ component: 'host-registry' });

  const heartbeatTimeoutMs = config.SHAREGRID_HEARTBEAT_TIMEOUT * 1000;
  // Eviction runs every third of the timeout so lag never exceeds one period.
  const evictionIntervalMs = Math.floor(heartbeatTimeoutMs / 3);

  const entries = new Map<string, HostEntry>();
  let evictionTimer: NodeJS.Timeout | null = null;

  return {
    add(entry: HostEntry): void {
      entries.set(entry.hostId, { ...entry });
      log.info({ hostId: entry.hostId, modelName: entry.modelName }, 'host added to registry');
    },

    updateHeartbeat(hostId: string, newToken: string, now: number): boolean {
      const entry = entries.get(hostId);
      if (entry === undefined) {
        log.warn({ hostId }, 'heartbeat for unknown host');
        return false;
      }
      entry.hostKeyToken = newToken;
      entry.lastSeen = now;
      return true;
    },

    list(): HostListEntry[] {
      return Array.from(entries.values()).map(
        (e): HostListEntry => ({
          hostId: e.hostId,
          modelName: e.modelName,
          endpoint: e.endpoint,
          tlsFingerprint: e.tlsFingerprint,
          hostKeyToken: e.hostKeyToken,
        }),
      );
    },

    evictStale(now: number): string[] {
      const cutoff = now - heartbeatTimeoutMs;
      const evicted: string[] = [];
      for (const [hostId, entry] of entries) {
        if (entry.lastSeen < cutoff) {
          entries.delete(hostId);
          evicted.push(hostId);
        }
      }
      if (evicted.length > 0) {
        log.warn({ evicted }, 'evicted stale hosts');
      }
      return evicted;
    },

    start(): void {
      evictionTimer = setInterval(() => {
        this.evictStale(Date.now());
      }, evictionIntervalMs);
      log.info({ evictionIntervalMs }, 'host registry eviction loop started');
    },

    stop(): void {
      if (evictionTimer !== null) {
        clearInterval(evictionTimer);
        evictionTimer = null;
      }
    },
  };
}
