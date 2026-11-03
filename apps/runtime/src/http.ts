import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  HTTP_STATUS_BY_CODE,
  isStudioError,
  StudioError,
  type ApiErrorBody,
  type ErrorCode,
} from '@research-studio/shared-types';
import type { AuditService } from './services/audit-service';
import type { Actor } from './services/project-service';

/** Validate untrusted input against a contract schema, throwing VALIDATION_FAILED. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new StudioError(
      'VALIDATION_FAILED',
      result.error.issues[0]?.message ?? 'Invalid request',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function actorOf(request: FastifyRequest): Actor {
  return { sessionId: request.session?.id ?? null };
}

function body(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Raw project files and library PDFs are never rendered as active documents by the runtime origin. */
export const RAW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

const FASTIFY_CODES: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

export function registerErrorHandling(app: FastifyInstance, audit: AuditService): void {
  app.setErrorHandler((error: FastifyError | StudioError | Error, request, reply) => {
    if (isStudioError(error)) {
      if (error.code === 'PATH_VIOLATION' || error.code === 'FORBIDDEN') {
        audit.record({
          action: 'request.path_violation',
          outcome: 'denied',
          actor: request.session?.id ?? null,
          target: request.url.split('?')[0] ?? null,
          details: { message: error.message, details: error.details as Record<string, unknown> },
        });
      }
      const status = HTTP_STATUS_BY_CODE[error.code];
      if (status >= 500) request.log.error({ err: error }, error.message);
      return reply.code(status).send(body(error.code, error.message, error.details));
    }
    const statusCode = (error as FastifyError).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      const code = FASTIFY_CODES[statusCode] ?? 'BAD_REQUEST';
      return reply.code(statusCode).send(body(code, error.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(body('INTERNAL', 'Internal runtime error'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(body('NOT_FOUND', `No route for ${request.method} ${request.url.split('?')[0]}`));
  });
}
