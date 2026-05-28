import { z } from 'zod';

const listenAddrPattern = /^.+:\d{1,5}$/;

const ConfigSchema = z.object({
  SHAREGRID_LISTEN_ADDR: z
    .string()
    .regex(listenAddrPattern, 'must match host:port'),
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
  const lastColon = data.SHAREGRID_LISTEN_ADDR.lastIndexOf(':');
  const host = data.SHAREGRID_LISTEN_ADDR.slice(0, lastColon);
  const port = parseInt(data.SHAREGRID_LISTEN_ADDR.slice(lastColon + 1), 10);

  return { ...data, host, port };
}
