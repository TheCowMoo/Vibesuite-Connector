/**
 * Deny-by-default path allowlist for the auth hook. Pure (no env import) so it
 * is trivially unit-testable.
 *
 * The webhook and OAuth callbacks MUST stay public: the Google webhook
 * authenticates itself via its channel token, and OAuth callbacks are browser
 * redirects that cannot carry our session cookie reliably.
 */
const PUBLIC_EXACT = new Set([
  '/',
  '/login',
  '/invite',
  '/favicon.ico',
  '/healthz',
  '/readyz',
  '/metrics',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/accept-invite',
]);

const PUBLIC_PREFIXES = ['/static/', '/webhooks/google/calendar', '/oauth/google', '/oauth/ghl', '/oauth/zoom'];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
