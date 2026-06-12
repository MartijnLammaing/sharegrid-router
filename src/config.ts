import { z } from 'zod';

import { parseEndpoint } from '@sharegrid/shared/tls';

const listenAddrPattern = /^.+:\d{1,5}$/;

const ConfigSchema = z.object({
  SHAREGRID_LISTEN_ADDR: z
    .string()
    .regex(listenAddrPattern, 'must match host:port'),
  // Network mode: `lan` (IPv4, default) or `internet` (IPv6-only). Determines
  // the address family advertised in the startup banner and stamped on URLs.
  SHAREGRID_NETWORK_MODE: z.enum(['lan', 'internet']).default('lan'),
  SHAREGRID_HEARTBEAT_TIMEOUT: z.coerce.number().int().positive().default(90),
});

export type Config = z.infer<typeof ConfigSchema> & {
  host: string;
  port: number;
};

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration error:', JSON.stringify(result.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }

  const data = result.data;
  // parseEndpoint is bracket-aware, so a `[::]:8443` IPv6 wildcard splits into
  // host `::` (the bare form Node's server.listen expects) and port 8443.
  const { host, port } = parseEndpoint(data.SHAREGRID_LISTEN_ADDR);

  return { ...data, host, port };
}
