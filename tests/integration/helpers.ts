/**
 * Shared helpers for router integration tests.
 */

import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import { loadOrGenerateCert } from '../../src/tls-cert-store.js';
import { createKeyAuthority } from '../../src/key-authority.js';
import { createHostRegistry } from '../../src/host-registry.js';
import { createTlsListener } from '../../src/tls-listener.js';
import pino from 'pino';

export const logger = pino({ level: 'silent' });

// ── Port helper ───────────────────────────────────────────────────────────────

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── NDJSON framing ────────────────────────────────────────────────────────────

export function sendMsg(sock: TLSSocket, msg: object): void {
  sock.write(JSON.stringify(msg) + '\n');
}

export function createReader(sock: TLSSocket): { read(): Promise<Record<string, unknown>> } {
  const queue: Array<Record<string, unknown>> = [];
  const pending: Array<(m: Record<string, unknown>) => void> = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (pending.length > 0) pending.shift()!(msg);
      else queue.push(msg);
    }
  });
  return {
    read(): Promise<Record<string, unknown>> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
}

/** @deprecated Use createReader(sock).read() instead */
export async function readMsg(sock: TLSSocket): Promise<Record<string, unknown>> {
  return createReader(sock).read();
}

// ── Router factory ────────────────────────────────────────────────────────────

export interface TestRouter {
  fingerprint: string;
  port: number;
  keyAuthority: ReturnType<typeof createKeyAuthority>;
  hostRegistry: ReturnType<typeof createHostRegistry>;
  tlsListener: ReturnType<typeof createTlsListener>;
  certDir: string;
  /** Host registration secret — include as `roleKey` in RegistrationPayload. */
  hostSecret: string;
  /** User access secret — include as `roleKey` in HostListRequest. */
  userSecret: string;
  teardown(): Promise<void>;
}

export async function startTestRouter(heartbeatTimeout = 90): Promise<TestRouter> {
  const certDir = mkdtempSync(join(tmpdir(), 'sgr-router-test-'));
  const { cert, key, fingerprint } = loadOrGenerateCert(
    join(certDir, 'router.crt'),
    join(certDir, 'router.key'),
  );

  const port = await getFreePort();
  const config = {
    SHAREGRID_LISTEN_ADDR: `127.0.0.1:${port}`,
    SHAREGRID_HEARTBEAT_TIMEOUT: heartbeatTimeout,
    host: '127.0.0.1',
    port,
  };

  const keyAuthority = createKeyAuthority({ logger });
  const hostRegistry = createHostRegistry({ config, logger });
  hostRegistry.start();

  const tlsListener = createTlsListener({
    config,
    logger,
    tlsCert: cert,
    tlsKey: key,
    keyAuthority,
    hostRegistry,
  });
  await tlsListener.start();

  return {
    fingerprint,
    port,
    keyAuthority,
    hostRegistry,
    tlsListener,
    certDir,
    hostSecret: keyAuthority.getHostSecret(),
    userSecret: keyAuthority.getUserSecret(),
    async teardown() {
      await tlsListener.stop();
      hostRegistry.stop();
      rmSync(certDir, { recursive: true, force: true });
    },
  };
}

// ── TLS client ────────────────────────────────────────────────────────────────

export function connectClient(port: number, fingerprint: string): Promise<TLSSocket> {
  const expected = fingerprint.toLowerCase();
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate().fingerprint256;
      const normalised = 'sha256:' + fp.replace(/:/g, '').toLowerCase();
      if (normalised !== expected) {
        sock.destroy();
        reject(new Error(`fingerprint mismatch: ${normalised} !== ${expected}`));
        return;
      }
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

// ── Registration helper ───────────────────────────────────────────────────────

/** Build a valid registration payload for a given router's host secret. */
export function makeValidRegistration(hostSecret: string) {
  return {
    v: PROTOCOL_VERSION,
    type: 'register',
    modelName: 'test-model',
    contextSize: 4096,
    port: 9000,
    tlsFingerprint: 'sha256:' + 'a'.repeat(64),
    roleKey: hostSecret,
  } as const;
}
