import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * List uploads are a JSON string, so both the proxy and Fastify must allow the same size.
 * A regression at either layer produces an opaque 413 before the route is reached.
 */
const appDir = process.cwd();
const repoRoot = join(appDir, '..');
const nginxConf = readFileSync(join(repoRoot, 'nginx', 'conf.d', 'default.conf'), 'utf8');
const appSource = readFileSync(join(appDir, 'src', 'api', 'app.ts'), 'utf8');
const appJs = readFileSync(join(appDir, 'public', 'app.js'), 'utf8');

describe('list upload body limit', () => {
  it('allows 25 MB at the Nginx edge', () => {
    expect(nginxConf).toMatch(/client_max_body_size\s+25m;/);
  });

  it('allows 25 MB in Fastify', () => {
    expect(appSource).toContain('const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;');
    expect(appSource).toContain('bodyLimit: MAX_REQUEST_BODY_BYTES');
  });

  it('turns a 413 into a useful panel message', () => {
    expect(appJs).toContain('res.status === 413');
    expect(appJs).toContain('up to 25 MB');
  });
});
