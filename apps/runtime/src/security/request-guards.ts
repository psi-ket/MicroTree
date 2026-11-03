import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StudioError } from '@research-studio/shared-types';
import type { AuditService } from '../services/audit-service';
import type { Session, SessionStore } from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyContextConfig {
    /** Route does not require a bearer session (it may still require Host/Origin checks). */
    public?: boolean;
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Extract the hostname from a Host header, keeping IPv6 brackets. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::\d+)?$/i.exec(hostHeader.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export interface GuardOptions {
  allowedOrigins: string[];
  sessions: SessionStore;
  audit: AuditService;
}

/**
 * Registers the request pipeline that every route passes through:
 *   1. Host header must be a loopback name (DNS-rebinding defence).
 *   2. Origin, when present, must be allow-listed; CORS headers only for allowed origins.
 *   3. Non-public routes require a valid bearer session.
 */
export function registerRequestGuards(app: FastifyInstance, options: GuardOptions): void {
  const allowed = new Set(options.allowedOrigins);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const hostname = hostnameOf(request.headers.host);
    if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) {
      options.audit.record({
        action: 'request.host_rejected',
        outcome: 'denied',
        target: String(request.headers.host ?? '').slice(0, 200),
      });
      throw new StudioError('HOST_REJECTED', 'Requests must address the runtime via a loopback host name');
    }

    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        options.audit.record({
          action: 'request.origin_rejected',
          outcome: 'denied',
          target: origin.slice(0, 200),
          details: { url: request.url.split('?')[0] },
        });
        throw new StudioError('ORIGIN_REJECTED', 'This origin is not allowed to use the runtime');
      }
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-expose-headers', 'content-length, content-type');
    }

    if (request.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        .header('access-control-allow-headers', 'authorization, content-type')
        .header('access-control-max-age', '600');
      if (request.headers['access-control-request-private-network'] === 'true') {
        reply.header('access-control-allow-private-network', 'true');
      }
      return reply.code(204).send();
    }

    if (request.routeOptions.config.public) return;

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const session = token ? options.sessions.validate(token) : null;
    if (!session) {
      throw new StudioError('UNAUTHORIZED', token ? 'Session expired or invalid' : 'Authentication required');
    }
    request.session = session;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-site');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
