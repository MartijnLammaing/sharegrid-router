/**
 * TLS Listener — the single inbound endpoint for both LLMHosts and LLMUsers.
 *
 * Responsibilities (Phase 1):
 *  - Accept TLS connections; demux on the first message.
 *  - `register` → host registration + heartbeat handler.
 *  - `host_list_request` → user handshake (fetch list, reply, close).
 *  - Enforce NDJSON framing with a 1 MiB cap.
 *  - Validate registration payloads; reject and close on failure.
 *  - Handle per-connection lifecycle bookkeeping.
 *
 * See: docs/architecture_llmrouter.md §2.1, §3
 *      docs/implementation_plan_llmrouter.md Phase 3C
 */

import { randomUUID } from 'node:crypto';
import { createServer as createTlsServer, type TLSSocket, type Server as TLSServer } from 'node:tls';
import type { Logger } from 'pino';
import {
  PROTOCOL_VERSION,
  type RegistrationPayload,
  type RegistrationAck,
  type HeartbeatPayload,
  type HeartbeatAck,
  type HostListRequest,
  type HostListResponse,
} from '@sharegrid/shared/protocol';
import { FINGERPRINT_REGEX } from '@sharegrid/shared/tls';
import type { KeyAuthority } from './key-authority.js';
import type { HostRegistry, HostEntry } from './host-registry.js';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface TlsListenerDeps {
  config: Config;
  logger: Logger;
  tlsCert: string;
  tlsKey: string;
  keyAuthority: KeyAuthority;
  hostRegistry: HostRegistry;
}

export interface TlsListener {
  start(): Promise<void>;
  /** Close the server; drain active connections with a 5-second cap. */
  stop(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB — defensive cap; document rationale:
// A single newline-delimited JSON message from either a host or user should
// never approach 1 MiB. This cap exists to prevent a misbehaving or malicious
// peer from exhausting router memory by streaming a large payload without
// sending a newline.

const DRAIN_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTlsListener(deps: TlsListenerDeps): TlsListener {
  const { config, logger, tlsCert, tlsKey, keyAuthority, hostRegistry } = deps;
  const log = logger.child({ component: 'tls-listener' });

  // TTL for host-key tokens: 2 × heartbeat timeout (in ms).
  const tokenTtlMs = 2 * config.SHAREGRID_HEARTBEAT_TIMEOUT * 1000;

  let server: TLSServer | null = null;
  const activeSockets = new Set<TLSSocket>();

  // ── NDJSON framing helper ─────────────────────────────────────────────────

  function writeMessage(sock: TLSSocket, msg: object): void {
    if (!sock.destroyed && sock.writable) {
      sock.write(JSON.stringify(msg) + '\n');
    }
  }

  // ── Registration validation ───────────────────────────────────────────────

  function isValidRegistrationPayload(msg: Record<string, unknown>): msg is Record<string, unknown> & RegistrationPayload {
    return (
      typeof msg['modelName'] === 'string' &&
      msg['modelName'].length > 0 &&
      typeof msg['port'] === 'number' &&
      Number.isInteger(msg['port']) &&
      msg['port'] >= 1 &&
      msg['port'] <= 65535 &&
      typeof msg['tlsFingerprint'] === 'string' &&
      FINGERPRINT_REGEX.test(msg['tlsFingerprint'])
    );
  }

  // ── Host connection handler ───────────────────────────────────────────────

  function handleHostConnection(sock: TLSSocket, registration: RegistrationPayload): void {
    // Derive the host endpoint from the socket's remote address + the reported port.
    const remoteAddress = sock.remoteAddress ?? '0.0.0.0';
    // Strip IPv6-mapped IPv4 prefix (::ffff:) if present.
    const host = remoteAddress.replace(/^::ffff:/, '');
    const endpoint = `${host}:${registration.port}`;

    const hostId = randomUUID();
    const token = keyAuthority.issueHostKeyToken(
      hostId,
      registration.tlsFingerprint,
      tokenTtlMs,
    );

    const entry: HostEntry = {
      hostId,
      modelName: registration.modelName,
      endpoint,
      tlsFingerprint: registration.tlsFingerprint,
      hostKeyToken: token,
      lastSeen: Date.now(),
    };
    hostRegistry.add(entry);

    const ack: RegistrationAck = {
      v: PROTOCOL_VERSION,
      type: 'register_ack',
      hostId,
      hostKeyToken: token,
      routerPublicKey: keyAuthority.getPublicKey(),
    };
    writeMessage(sock, ack);
    log.info({ hostId, endpoint, modelName: registration.modelName }, 'host registered');

    // ── Post-registration: heartbeat loop ────────────────────────────────

    let buf = '';

    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_MESSAGE_BYTES) {
        log.warn({ hostId }, 'host message exceeded 1 MiB; closing');
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        handleHeartbeat(line, hostId, sock);
      }
    });

    sock.on('close', () => {
      // No explicit registry change on close — the eviction loop handles it.
      log.info({ hostId }, 'host connection closed');
    });

    sock.on('error', (err) => {
      log.warn({ hostId, err }, 'host socket error');
    });
  }

  function handleHeartbeat(line: string, hostId: string, sock: TLSSocket): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      log.warn({ hostId }, 'non-JSON heartbeat line; closing');
      sock.destroy();
      return;
    }

    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
    ) {
      log.warn({ hostId }, 'unexpected protocol version in heartbeat; closing');
      sock.destroy();
      return;
    }

    const msg = raw as Record<string, unknown>;
    if (msg['type'] !== 'heartbeat') {
      log.warn({ hostId, type: msg['type'] }, 'unexpected message type after registration; closing');
      sock.destroy();
      return;
    }

    const hb = msg as unknown as HeartbeatPayload;
    if (hb.hostId !== hostId) {
      log.warn({ expected: hostId, got: hb.hostId }, 'heartbeat hostId mismatch; closing');
      sock.destroy();
      return;
    }

    const now = Date.now();
    const newToken = keyAuthority.issueHostKeyToken(
      hostId,
      // We need the fingerprint for the new token. Re-use the one in the registry entry.
      // The registry's hostKeyToken payload contains it, but it's simpler to look up
      // the entry directly.
      getHostFingerprint(hostId),
      tokenTtlMs,
    );

    const updated = hostRegistry.updateHeartbeat(hostId, newToken, now);
    if (!updated) {
      // Host was evicted while the connection was open (e.g. missed many beats).
      log.warn({ hostId }, 'heartbeat for evicted host; closing connection');
      sock.destroy();
      return;
    }

    const ack: HeartbeatAck = { v: PROTOCOL_VERSION, type: 'heartbeat_ack', hostKeyToken: newToken };
    writeMessage(sock, ack);
    log.debug({ hostId }, 'heartbeat acknowledged');
  }

  // The registry stores the token but not the fingerprint separately. We decode
  // it from the entry's hostKeyToken payload to avoid storing redundant data.
  function getHostFingerprint(hostId: string): string {
    const hosts = hostRegistry.list();
    const entry = hosts.find((h) => h.hostId === hostId);
    if (entry === undefined) {
      // Host was evicted; return an empty string (caller handles the evicted case).
      return '';
    }
    return entry.tlsFingerprint;
  }

  // ── User connection handler ───────────────────────────────────────────────

  function handleUserConnection(sock: TLSSocket): void {
    const hosts = hostRegistry.list();
    const response: HostListResponse = {
      v: PROTOCOL_VERSION,
      type: 'host_list_response',
      hosts,
    };
    writeMessage(sock, response);
    // Router closes the connection after the reply — it is not involved further.
    sock.end();
    log.info({ hostCount: hosts.length }, 'host list sent to user');
  }

  // ── Connection demux ──────────────────────────────────────────────────────

  function handleConnection(sock: TLSSocket): void {
    activeSockets.add(sock);
    sock.once('close', () => activeSockets.delete(sock));
    sock.on('error', (err) => log.warn({ err }, 'socket error'));

    let buf = '';
    sock.setEncoding('utf8');

    const onFirstMessage = (chunk: string): void => {
      buf += chunk;
      if (buf.length > MAX_MESSAGE_BYTES) {
        log.warn('first message exceeded 1 MiB; closing');
        sock.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for more data

      const line = buf.slice(0, nl).trim();
      // Stop the first-message listener; handlers attach their own.
      sock.removeListener('data', onFirstMessage);

      if (line.length === 0) {
        sock.destroy();
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        log.warn('non-JSON first message; closing');
        sock.destroy();
        return;
      }

      if (
        typeof raw !== 'object' ||
        raw === null ||
        (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
      ) {
        log.warn('protocol version mismatch on first message; closing');
        sock.destroy();
        return;
      }

      const msg = raw as Record<string, unknown>;

      if (msg['type'] === 'register') {
        // Validate role key before anything else — fail closed with no registry write.
        const roleKey = msg['roleKey'];
        if (typeof roleKey !== 'string' || roleKey !== keyAuthority.getHostSecret()) {
          log.warn('registration rejected: missing or invalid roleKey');
          sock.destroy();
          return;
        }
        if (!isValidRegistrationPayload(msg)) {
          log.warn({ msg }, 'invalid registration payload; closing');
          sock.destroy();
          return;
        }
        handleHostConnection(sock, msg);
      } else if (msg['type'] === 'host_list_request') {
        // Validate role key — fail closed if missing or wrong role.
        const roleKey = msg['roleKey'];
        if (typeof roleKey !== 'string' || roleKey !== keyAuthority.getUserSecret()) {
          log.warn('host list request rejected: missing or invalid roleKey');
          sock.destroy();
          return;
        }
        // Validate the HostListRequest shape (v + type + roleKey already validated).
        const _req = msg as unknown as HostListRequest;
        void _req;
        handleUserConnection(sock);
      } else {
        // Unknown initial message type — close with no response.
        log.warn({ type: msg['type'] }, 'unknown first message type; closing');
        sock.destroy();
      }
    };

    sock.on('data', onFirstMessage);
  }

  // ── Public interface ──────────────────────────────────────────────────────

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createTlsServer({ cert: tlsCert, key: tlsKey }, handleConnection);
        server.on('error', reject);
        server.listen(config.port, config.host, () => {
          log.info({ host: config.host, port: config.port }, 'TLS listener started');
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server === null) {
          resolve();
          return;
        }

        // Stop accepting new connections.
        server.close(() => resolve());

        // Drain active connections with a hard cap.
        const timer = setTimeout(() => {
          for (const sock of activeSockets) {
            sock.destroy();
          }
          resolve();
        }, DRAIN_TIMEOUT_MS);
        timer.unref();
      });
    },
  };
}
