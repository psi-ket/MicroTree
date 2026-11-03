import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  API_PREFIX,
  API_VERSION,
  AuditQuery,
  CreateEntryRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  DeleteProjectQuery,
  JobParams,
  PathQuery,
  ProjectParams,
  RenameEntryRequest,
  SynctexForwardRequest,
  SynctexInverseRequest,
  UpdateProjectRequest,
  UpdateSettingsRequest,
  WriteFileRequest,
  WS_PATH,
} from '@research-studio/api-contracts';
import { extname } from '@research-studio/document-engine';
import { MAX_TEXT_FILE_BYTES } from '@research-studio/document-engine/node';
import type { Toolchain } from '@research-studio/latex-engine';
import { StudioError } from '@research-studio/shared-types';
import { z } from 'zod';
import { RUNTIME_VERSION, type RuntimeConfig } from './config';
import { actorOf, parse, RAW_CSP } from './http';
import { registerAiRoutes, type AiRouteDeps } from './routes-ai';
import { registerDocumentRoutes } from './routes-documents';
import { registerLibraryRoutes } from './routes-library';
import { registerLiteratureRoutes } from './routes-literature';
import type { DocumentRuntime } from './services/document-runtime';
import type { LibraryRuntime } from './services/library-runtime';
import type { LiteratureService } from './services/literature-service';
import { RateLimiter, safeEqual, type SessionStore, type TicketStore } from './security/tokens';
import type { AuditService } from './services/audit-service';
import type { CompileService } from './services/compile-service';
import type { ProjectService } from './services/project-service';
import type { SettingsService } from './services/settings-service';
import type { WsHub } from './ws-hub';

export interface RouteDeps {
  config: RuntimeConfig;
  pairingToken: string;
  sessions: SessionStore;
  tickets: TicketStore;
  audit: AuditService;
  projects: ProjectService;
  compile: CompileService;
  settings: SettingsService;
  toolchain: Toolchain;
  hub: WsHub;
  ai: AiRouteDeps;
  literature: LiteratureService;
  library: LibraryRuntime;
  documents: DocumentRuntime;
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  eps: 'application/postscript',
};


export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, sessions, tickets, audit, projects, compile, settings } = deps;
  const authLimiter = new RateLimiter(10, 60_000);

  app.register(
    async (api) => {
      // ------------------------------------------------------------ public
      api.get('/health', { config: { public: true } }, async () => ({
        status: 'ok' as const,
        name: 'research-studio-runtime' as const,
        version: RUNTIME_VERSION,
        apiVersion: API_VERSION,
      }));

      api.post('/auth/session', { config: { public: true } }, async (request, reply) => {
        if (!authLimiter.hit(request.ip)) {
          audit.record({ action: 'auth.session', outcome: 'denied', details: { reason: 'rate_limited' } });
          throw new StudioError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
        }
        const { pairingToken } = parse(CreateSessionRequest, request.body);
        if (!safeEqual(pairingToken, deps.pairingToken)) {
          audit.record({ action: 'auth.session', outcome: 'denied', details: { reason: 'bad_token' } });
          throw new StudioError('UNAUTHORIZED', 'The pairing token is not valid for this runtime');
        }
        const { token, session } = sessions.create();
        audit.record({ action: 'auth.session', outcome: 'success', actor: session.id });
        return reply.code(201).send({ sessionToken: token, expiresAt: new Date(session.expiresAt).toISOString() });
      });

      // ------------------------------------------------------------ session
      api.delete('/auth/session', async (request, reply) => {
        const token = request.headers.authorization!.slice(7).trim();
        sessions.revoke(token);
        audit.record({ action: 'auth.logout', outcome: 'success', actor: request.session!.id });
        return reply.code(204).send();
      });

      api.post('/auth/ws-ticket', async (request) => {
        const { ticket, expiresAt } = tickets.issue(request.session!.id);
        return { ticket, expiresAt: new Date(expiresAt).toISOString() };
      });

      api.get('/runtime/info', async () => ({
        version: RUNTIME_VERSION,
        platform: `${process.platform}-${process.arch}`,
        workspaceRoot: config.workspaceRoot,
        toolchain: deps.toolchain.status,
        limits: {
          maxUploadBytes: config.maxUploadBytes,
          compileTimeoutMs: config.compileTimeoutMs,
          maxTextFileBytes: MAX_TEXT_FILE_BYTES,
        },
      }));

      // ------------------------------------------------------------ projects
      api.get('/projects', async () => ({ projects: projects.list() }));

      api.post('/projects', async (request, reply) => {
        const input = parse(CreateProjectRequest, request.body);
        const project = await projects.create(input, actorOf(request));
        return reply.code(201).send({ project });
      });

      api.get('/projects/:projectId', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        return { project: await projects.markOpened(projectId) };
      });

      api.patch('/projects/:projectId', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        const patch = parse(UpdateProjectRequest, request.body);
        return { project: await projects.update(projectId, patch, actorOf(request)) };
      });

      api.delete('/projects/:projectId', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        const { deleteFiles } = parse(DeleteProjectQuery, request.query);
        compile.cancel(projectId, actorOf(request));
        await projects.delete(projectId, deleteFiles, actorOf(request));
        return reply.code(204).send();
      });

      // ------------------------------------------------------------ files
      api.get('/projects/:projectId/tree', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        return { tree: await projects.tree(projectId) };
      });

      api.get('/projects/:projectId/symbols', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        return projects.symbols(projectId);
      });

      api.get('/projects/:projectId/files/content', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        const { path } = parse(PathQuery, request.query);
        return projects.readFile(projectId, path);
      });

      api.put(
        '/projects/:projectId/files/content',
        { bodyLimit: MAX_TEXT_FILE_BYTES * 3 },
        async (request) => {
          const { projectId } = parse(ProjectParams, request.params);
          const input = parse(WriteFileRequest, request.body);
          return { file: await projects.writeFile(projectId, input, actorOf(request)) };
        },
      );

      api.post('/projects/:projectId/files', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        const input = parse(CreateEntryRequest, request.body);
        return reply.code(201).send({ entry: await projects.createEntry(projectId, input, actorOf(request)) });
      });

      api.post('/projects/:projectId/files/rename', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        const { from, to } = parse(RenameEntryRequest, request.body);
        return { entry: await projects.rename(projectId, from, to, actorOf(request)) };
      });

      api.delete('/projects/:projectId/files', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        const { path } = parse(PathQuery, request.query);
        await projects.deleteEntry(projectId, path, actorOf(request));
        return reply.code(204).send();
      });

      api.get('/projects/:projectId/files/raw', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        const { path } = parse(PathQuery, request.query);
        const file = await projects.readRaw(projectId, path);
        return reply
          .type(RAW_CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream')
          .header('content-security-policy', RAW_CSP)
          .header('content-disposition', 'inline')
          .send(file.bytes);
      });

      api.post('/projects/:projectId/uploads', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        if (!request.isMultipart()) {
          throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data');
        }
        const part = await request.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 } });
        if (!part) throw new StudioError('BAD_REQUEST', 'No file was uploaded');
        const bytes = await part.toBuffer();
        const dirField = part.fields.directory;
        const directory =
          dirField && !Array.isArray(dirField) && dirField.type === 'field' ? String(dirField.value ?? '') : '';
        const file = await projects.upload(projectId, { directory, fileName: part.filename, bytes }, actorOf(request));
        return reply.code(201).send({ file });
      });

      // ------------------------------------------------------------ compile
      api.post('/projects/:projectId/compile', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        return reply.code(202).send({ job: await compile.request(projectId, actorOf(request)) });
      });

      api.post('/projects/:projectId/compile/cancel', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        projects.get(projectId);
        return { job: compile.cancel(projectId, actorOf(request)) };
      });

      api.get('/projects/:projectId/compile/jobs', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        return { jobs: compile.listJobs(projectId) };
      });

      api.get('/projects/:projectId/compile/jobs/:jobId', async (request) => {
        const { projectId, jobId } = parse(JobParams, request.params);
        return compile.getJob(projectId, jobId);
      });

      api.get('/projects/:projectId/pdf', async (request, reply) => {
        const { projectId } = parse(ProjectParams, request.params);
        const pdfPath = await compile.pdfPath(projectId);
        return reply
          .type('application/pdf')
          .header('content-security-policy', RAW_CSP)
          .send(createReadStream(pdfPath));
      });

      api.post('/projects/:projectId/synctex/forward', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        const input = parse(SynctexForwardRequest, request.body);
        return { rects: await compile.forward(projectId, input) };
      });

      api.post('/projects/:projectId/synctex/inverse', async (request) => {
        const { projectId } = parse(ProjectParams, request.params);
        const input = parse(SynctexInverseRequest, request.body);
        return { location: await compile.inverse(projectId, input) };
      });

      // ------------------------------------------------------------ settings & audit
      api.get('/settings', async () => ({ settings: settings.get() }));

      api.patch('/settings', async (request) => {
        const patch = parse(UpdateSettingsRequest, request.body);
        return { settings: settings.update(patch) };
      });

      api.get('/audit', async (request) => {
        const query = parse(AuditQuery, request.query);
        return { events: audit.list(query) };
      });

      registerAiRoutes(api, deps.ai);
      registerLiteratureRoutes(api, deps.literature);
      registerLibraryRoutes(api, deps.library, projects);
      registerDocumentRoutes(api, deps.documents);
    },
    { prefix: API_PREFIX },
  );

  // ------------------------------------------------------------ websocket
  const WsQuery = z.object({ ticket: z.string().min(16).max(128) });
  app.get(
    WS_PATH,
    {
      websocket: true,
      config: { public: true },
      preValidation: async (request) => {
        const parsed = WsQuery.safeParse(request.query);
        const sessionId = parsed.success ? tickets.consume(parsed.data.ticket) : null;
        if (!sessionId || !sessions.isActive(sessionId)) {
          audit.record({ action: 'ws.connect', outcome: 'denied' });
          throw new StudioError('UNAUTHORIZED', 'Invalid or expired WebSocket ticket');
        }
        request.session = { id: sessionId, createdAt: 0, expiresAt: 0 };
      },
    },
    (socket, request) => {
      deps.hub.add(socket, request.session!.id);
    },
  );
}
