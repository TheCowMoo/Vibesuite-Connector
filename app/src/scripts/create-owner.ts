import { logger } from '../lib/logger';
import { hashPassword } from '../lib/passwords';
import { countUsers, createUser, pushAudit } from '../domain/authStore';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email') || process.env.ADMIN_EMAIL;
  const password = arg('password') || process.env.ADMIN_PASSWORD;
  const name = arg('name') || email;

  if (!email || !password) {
    throw new Error(
      'usage: npm run create-owner -- --email you@example.com --password "your-password"  (or set ADMIN_EMAIL / ADMIN_PASSWORD)'
    );
  }
  if (password.length < 8) throw new Error('password must be at least 8 characters');

  const existing = await countUsers();
  if (existing > 0) logger.warn({ existing }, 'users already exist — creating an additional owner');

  const user = await createUser({
    email,
    name: name as string,
    role: 'owner',
    status: 'active',
    passwordHash: hashPassword(password),
    createdBy: 'cli',
  });

  await pushAudit({ at: Date.now(), actor: 'cli', action: 'owner_created', detail: user.email });
  logger.info({ email: user.email, id: user.id }, 'owner created');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'create-owner failed');
    process.exit(1);
  });
