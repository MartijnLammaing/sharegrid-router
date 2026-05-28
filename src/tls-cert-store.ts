import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { chmodSync } from 'fs';
import { dirname } from 'path';
import selfsigned from 'selfsigned';
import { computeFingerprint } from '@sharegrid/shared/tls';

const CERT_PATH = '/data/certs/router.crt';
const KEY_PATH = '/data/certs/router.key';

export interface CertBundle {
  cert: string;
  key: string;
  fingerprint: string;
}

export function loadOrGenerateCert(
  certPath = CERT_PATH,
  keyPath = KEY_PATH,
): CertBundle {
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    const fingerprint = computeFingerprint(cert);
    return { cert, key, fingerprint };
  }

  const dir = dirname(certPath);
  if (!existsSync(dir)) {
    // Fails closed: if the directory cannot be created the error propagates.
    mkdirSync(dir, { recursive: true });
  }

  // Generate a self-signed RSA-2048 cert. RSA is chosen here because the
  // selfsigned package's Ed25519 support is incomplete across Node versions,
  // and the router cert is used for TLS transport only — not for Ed25519
  // signing (which is handled separately by the Key Authority).
  const attrs = [{ name: 'commonName', value: 'sharegrid-router' }];
  const pems = selfsigned.generate(attrs, { keySize: 2048, days: 3650 });

  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o600);

  const fingerprint = computeFingerprint(pems.cert);
  return { cert: pems.cert, key: pems.private, fingerprint };
}
