process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';
process.env.GOOGLE_WEBHOOK_URL =
  process.env.GOOGLE_WEBHOOK_URL || 'http://localhost:3000/webhooks/google/calendar';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
