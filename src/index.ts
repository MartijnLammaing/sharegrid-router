/**
 * LLMRouter entry point — wires all components together and manages the process lifecycle.
 *
 * Startup sequence (tasks 3D-2, 3D-3):
 *  1. Load and validate configuration.
 *  2. Construct logger.
 *  3. Load or generate TLS cert.
 *  4. Create Key Authority.
 *  5. Create Host Registry and start eviction loop.
 *  6. Create TLS Listener and start it.
 *  7. Print startup banner.
 *  8. Register SIGTERM/SIGINT for graceful shutdown.
 *
 * See: docs/architecture_llmrouter.md §3
 *      docs/implementation_plan_llmrouter.md Phase 3D
 */

import { loadConfig } from './config.js';
import { createComponentLogger } from './logger.js';
import { loadOrGenerateCert } from './tls-cert-store.js';
import { createKeyAuthority } from './key-authority.js';
import { createHostRegistry } from './host-registry.js';
import { createTlsListener } from './tls-listener.js';
import { printStartupBanner } from './startup-banner.js';

async function main(): Promise<void> {
  // 1. Config — exits on invalid input.
  const config = loadConfig();

  // 2. Logger.
  const logger = createComponentLogger('main');
  logger.info('starting LLMRouter');

  // 3. TLS cert — load from /data/certs or generate on first run.
  const { cert, key, fingerprint } = loadOrGenerateCert();
  logger.info({ fingerprint }, 'TLS cert ready');

  // 4. Key Authority — Ed25519 keypair generated synchronously.
  const keyAuthority = createKeyAuthority({ logger });

  // 5. Host Registry — start background eviction loop.
  const hostRegistry = createHostRegistry({ config, logger });
  hostRegistry.start();

  // 6. TLS Listener — bind and start accepting connections.
  const tlsListener = createTlsListener({
    config,
    logger,
    tlsCert: cert,
    tlsKey: key,
    keyAuthority,
    hostRegistry,
  });
  await tlsListener.start();

  // 7. Startup banner — printed to stdout for the operator.
  printStartupBanner({
    listenAddr: config.SHAREGRID_LISTEN_ADDR,
    fingerprint,
    hostSecret: keyAuthority.getHostSecret(),
    userSecret: keyAuthority.getUserSecret(),
  });

  // 8. SIGTERM/SIGINT handlers for graceful shutdown.
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');
    await tlsListener.stop();
    hostRegistry.stop();
    logger.info('graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('LLMRouter ready');
}

main().catch((err: unknown) => {
  console.error('fatal error during startup:', err);
  process.exit(1);
});
