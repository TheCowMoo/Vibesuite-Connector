import { logger } from '../lib/logger';
import { bootstrapConnection } from '../domain/bootstrap';

async function main(): Promise<void> {
  const connectionId = process.argv[2];
  if (!connectionId) {
    logger.error('usage: npm run bootstrap -- <connectionId>');
    process.exit(1);
  }
  await bootstrapConnection(connectionId);
}

main()
  .then(() => {
    logger.info('bootstrap complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'bootstrap failed');
    process.exit(1);
  });

