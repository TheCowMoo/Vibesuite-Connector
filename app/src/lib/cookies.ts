import type { FastifyReply, FastifyRequest } from 'fastify';

/** Read a single cookie value without pulling in a cookie dependency. */
export function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export function setCookie(reply: FastifyReply, name: string, value: string, opts: CookieOptions = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearCookie(reply: FastifyReply, name: string, opts: CookieOptions = {}): void {
  const parts = [`${name}=`, `Path=${opts.path ?? '/'}`, 'Max-Age=0', 'HttpOnly'];
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  reply.header('Set-Cookie', parts.join('; '));
}
