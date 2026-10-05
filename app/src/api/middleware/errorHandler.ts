import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function errorHandler(err: FastifyError, _req: FastifyRequest, reply: FastifyReply): void {
  const status = (err as { statusCode?: number }).statusCode ?? err.statusCode ?? 500;
  reply.status(status).send({ error: err.message ?? 'internal error' });
}
