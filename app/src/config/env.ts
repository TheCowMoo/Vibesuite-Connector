import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // Public base URL (origin) used for OAuth redirect URIs and dashboard links.
  OAUTH_BASE_URL: z.string().url(),
  // Global Google push notification endpoint.
  GOOGLE_WEBHOOK_URL: z.string().url(),

  // OAuth app credentials (required only for OAuth onboarding flows).
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_PATH: z.string().default('/oauth/google/callback'),
  GHL_OAUTH_CLIENT_ID: z.string().optional(),
  GHL_OAUTH_CLIENT_SECRET: z.string().optional(),
  GHL_OAUTH_REDIRECT_PATH: z.string().default('/oauth/ghl/callback'),

  // Encryption key for stored credentials (recommended in production).
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),

  // Legacy / seed connection defaults (optional — used by the seed script only).
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  GOOGLE_SUBJECT: z.string().optional(),

  // GHL (shared defaults / seed).
  GHL_BASE_URL: z.string().url().default('https://services.leadconnectorhq.com'),
  GHL_VERSION: z.string().default('2021-07-28'),
  GHL_LOCATION_ID: z.string().optional(),
  GHL_API_TOKEN: z.string().optional(),
  GHL_WEBHOOK_YES: z.string().url().optional(),
  GHL_WEBHOOK_MAYBE: z.string().url().optional(),
  GHL_WEBHOOK_NO: z.string().url().optional(),
  GHL_RSVP_CUSTOM_FIELD_ID: z.string().optional(),

  WATCH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  WATCH_RENEWAL_THRESHOLD_DAYS: z.coerce.number().int().positive().default(5),
  WATCH_RENEWAL_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(86400000),
  LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(5),
  SYNC_QUEUE_NAME: z.string().default('sync-queue'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  METRICS_PORT: z.coerce.number().int().min(0).default(9090),
  SYNC_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SYNC_BACKOFF_DELAY_MS: z.coerce.number().int().positive().default(2000),
  INVITE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  INVITE_DELAY_MS: z.coerce.number().int().min(0).default(300),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
export type Env = z.infer<typeof EnvSchema>;

