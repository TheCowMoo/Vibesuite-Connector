import { buildApp } from './app';
import { env } from '../config/env';
import { logger } from '../lib/logger';

async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT }, 'ingestion API listening');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to start API');
    process.exit(1);
  }
}

void main();
