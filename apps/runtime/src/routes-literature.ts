import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LiteratureAuthorParams,
  LiteratureHistoryParams,
  LiteratureHistoryQuery,
  LiteratureProviderParams,
  LiteratureRelatedQuery,
  LiteratureResolveParams,
  LiteratureSearchRequestSchema,
  LiteratureWorkParams,
  UpdateLiteraturePreferencesRequest,
  UpdateLiteratureProviderRequest,
} from '@research-studio/api-contracts';
import { actorOf, parse } from './http';
import type { LiteratureService } from './services/literature-service';

/**
 * Abort provider requests when the client goes away (closed tab, cancelled
 * search). `close` on the response fires both after a normal reply and on a
 * dropped connection; only the latter aborts.
 */
export function clientSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort(new Error('client disconnected'));
  });
  return controller.signal;
}

/** Literature routes, registered inside the authenticated `/api/v1` scope. */
export function registerLiteratureRoutes(api: FastifyInstance, literature: LiteratureService): void {
  api.get('/literature/providers', async () => ({ providers: await literature.providers(), ...literature.status() }));

  api.patch('/literature/providers/:providerId', async (request) => {
    const { providerId } = parse(LiteratureProviderParams, request.params);
    const patch = parse(UpdateLiteratureProviderRequest, request.body);
    return { provider: await literature.updateProvider(providerId, patch, actorOf(request)) };
  });

  api.post('/literature/providers/:providerId/test', async (request, reply) => {
    const { providerId } = parse(LiteratureProviderParams, request.params);
    return { provider: await literature.testProvider(providerId, clientSignal(reply)) };
  });

  api.post('/literature/search', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const input = parse(LiteratureSearchRequestSchema, request.body);
    return literature.search(input, clientSignal(reply));
  });

  api.get('/literature/works/:workId', async (request, reply) => {
    const { workId } = parse(LiteratureWorkParams, request.params);
    return literature.work(workId, clientSignal(reply));
  });

  api.get('/literature/works/:workId/references', async (request, reply) => {
    const { workId } = parse(LiteratureWorkParams, request.params);
    const { limit } = parse(LiteratureRelatedQuery, request.query);
    return literature.related('references', workId, limit, clientSignal(reply));
  });

  api.get('/literature/works/:workId/citations', async (request, reply) => {
    const { workId } = parse(LiteratureWorkParams, request.params);
    const { limit } = parse(LiteratureRelatedQuery, request.query);
    return literature.related('citations', workId, limit, clientSignal(reply));
  });

  api.get('/literature/resolve/doi/*', async (request, reply) => {
    const { '*': doi } = parse(LiteratureResolveParams, request.params);
    return literature.resolveDoi(doi, clientSignal(reply));
  });

  api.get('/literature/resolve/arxiv/*', async (request, reply) => {
    const { '*': id } = parse(LiteratureResolveParams, request.params);
    return literature.resolveArxiv(id, clientSignal(reply));
  });

  api.get('/literature/authors/:authorId', async (request, reply) => {
    const { authorId } = parse(LiteratureAuthorParams, request.params);
    return { author: await literature.author(authorId, clientSignal(reply)) };
  });

  api.get('/literature/history', async (request) => {
    const { limit } = parse(LiteratureHistoryQuery, request.query);
    return { entries: literature.history(limit) };
  });

  api.delete('/literature/history/:entryId', async (request, reply) => {
    const { entryId } = parse(LiteratureHistoryParams, request.params);
    literature.deleteHistoryEntry(entryId);
    return reply.code(204).send();
  });

  api.delete('/literature/history', async (request, reply) => {
    literature.clearHistory(actorOf(request));
    return reply.code(204).send();
  });

  api.get('/literature/preferences', async () => ({ preferences: literature.preferences() }));

  api.patch('/literature/preferences', async (request) => {
    const patch = parse(UpdateLiteraturePreferencesRequest, request.body);
    return { preferences: literature.updatePreferences(patch) };
  });

  api.delete('/literature/cache', async (request) => ({ cleared: literature.clearCache(actorOf(request)) }));
}
