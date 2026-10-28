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

  // Zoom user-managed General App (the optional per-connection authorisation). The
  // server-to-server credentials live in Settings → Video conferencing, not here.
  ZOOM_OAUTH_CLIENT_ID: z.string().optional(),
  ZOOM_OAUTH_CLIENT_SECRET: z.string().optional(),
  ZOOM_OAUTH_REDIRECT_PATH: z.string().default('/oauth/zoom/callback'),
  /** Optional: pin the scopes on the authorise URL. Empty means "use whatever the Zoom app allows". */
  ZOOM_OAUTH_SCOPES: z.string().default(''),

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
  // Catch-up sweep so a dropped push notification cannot strand an RSVP. 0 disables it.
  SYNC_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(900000),
  INVITE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  INVITE_DELAY_MS: z.coerce.number().int().min(0).default(300),
  ATTENDANCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(900000),
  ATTENDANCE_FETCH_DELAY_MIN: z.coerce.number().int().min(0).default(15),
  ATTENDANCE_MIN_SECONDS: z.coerce.number().int().min(0).default(60),
  ATTENDANCE_MATCH_MODE: z.enum(['email', 'email_or_name']).default('email'),
  GHL_TAG_ATTENDED: z.string().default('attended'),
  GHL_TAG_NO_SHOW: z.string().default('no-show'),
  GHL_TAG_NOT_INVITED: z.string().default('not-invited'),
  AUTH_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AUTH_COOKIE_NAME: z.string().default('vibesuite_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  AUTH_ALLOW_FIRST_RUN_SETUP: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  TEAM_INVITE_WEBHOOK_URL: z.string().url().optional(),
  // System email via GoHighLevel (team invites and account notices — never calendar invitations).
  // Optional env defaults; anything saved in Team → System email wins over these.
  SYSTEM_EMAIL_GHL_TOKEN: z.string().optional(),
  SYSTEM_EMAIL_GHL_LOCATION_ID: z.string().optional(),
  SYSTEM_EMAIL_FROM: z.string().email().optional(),
  CAMPAIGN_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  CAMPAIGN_DEFAULT_DAILY_CAP: z.coerce.number().int().positive().default(800),
  CAMPAIGN_DEFAULT_HOURLY_CAP: z.coerce.number().int().positive().default(100),
  CAMPAIGN_DEFAULT_MIN_DELAY_MS: z.coerce.number().int().min(0).default(5000),
  CAMPAIGN_COOLDOWN_ON_ERRORS: z.coerce.number().int().positive().default(3),
  CAMPAIGN_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
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

