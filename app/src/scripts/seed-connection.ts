import fs from 'node:fs';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { newConnectionId, saveConnection } from '../domain/connectionStore';
import { bootstrapConnection } from '../domain/bootstrap';
import type { StoredConnection } from '../domain/connection';

function resolveServiceAccount(): { email: string; key: string } {
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    const raw = fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { client_email: string; private_key: string };
    return { email: parsed.client_email, key: parsed.private_key };
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return { email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_SERVICE_ACCOUNT_KEY };
  }
  throw new Error('seed requires GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_KEY');
}

async function main(): Promise<void> {
  if (!env.GOOGLE_CALENDAR_ID) throw new Error('GOOGLE_CALENDAR_ID is required for seed');
  if (!env.GHL_API_TOKEN) throw new Error('GHL_API_TOKEN is required for seed');
  const { email, key } = resolveServiceAccount();

  const id = newConnectionId();
  const now = Date.now();
  const conn: StoredConnection = {
    id,
    name: env.GOOGLE_CALENDAR_ID,
    status: 'active',
    googleCalendarId: env.GOOGLE_CALENDAR_ID,
    googleAuthType: 'service_account',
    googleServiceAccountEmail: email,
    googleServiceAccountKey: key,
    googleSubject: env.GOOGLE_SUBJECT,
    ghlAuthType: 'api_token',
    ghlLocationId: env.GHL_LOCATION_ID ?? '',
    ghlApiToken: env.GHL_API_TOKEN,
    webhookUrls: { yes: env.GHL_WEBHOOK_YES, maybe: env.GHL_WEBHOOK_MAYBE, no: env.GHL_WEBHOOK_NO },
    createdAt: now,
    updatedAt: now,
  };

  await saveConnection(conn);
  logger.info({ connectionId: id, calendarId: conn.googleCalendarId }, 'seed connection created');

  await bootstrapConnection(id);
  logger.info({ connectionId: id }, 'seed complete');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'seed failed');
    process.exit(1);
  });
