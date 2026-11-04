import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { WS_MAX_CLIENT_MESSAGE_BYTES } from '@research-studio/api-contracts';
import type { AgentProvider } from '@research-studio/ai-core';
import { createAiRepositories, type AiDb, type SecretStore } from '@research-studio/ai-storage';
import type { Repositories, StudioDb } from '@research-studio/database';
import type { Toolchain } from '@research-studio/latex-engine';
import type { RuntimeConfig } from './config';
import { EventBus } from './events';
import { registerErrorHandling } from './http';
import { registerRoutes } from './routes';
import { AgentService } from './services/ai/agent-service';
import { StagingLifecycle } from './services/ai/staging-lifecycle';
import { FileWatchService } from './services/file-watch-service';
import { DocumentRuntime, type DocumentRuntimeOptions } from './services/document-runtime';
import { LibraryRuntime, type LibraryRuntimeOptions } from './services/library-runtime';
import { VisualRuntime } from './services/visual-runtime';
import { EvidenceRuntime } from './services/evidence-runtime';
import { AssistantService } from './services/ai/assistant-service';
import { ProposalService } from './services/ai/proposal-service';
import { AiProviderService, type ModelProviderFactory } from './services/ai/provider-service';
import { registerRequestGuards } from './security/request-guards';
import { SessionStore, TicketStore } from './security/tokens';
import { AuditService } from './services/audit-service';
import { CompileService } from './services/compile-service';
import { LiteratureService, type LiteratureServiceOptions } from './services/literature-service';
import { ProjectService } from './services/project-service';
import { SettingsService } from './services/settings-service';
import { WsHub } from './ws-hub';

export interface AppDeps {
  config: RuntimeConfig;
  repos: Repositories;
  toolchain: Toolchain;
  pairingToken: string;
  logger?: FastifyServerOptions['logger'];
  ai: {
    db: AiDb;
    secrets: SecretStore;
    /** Environment used for API-key fallbacks and agent processes (default: process.env). */
    env?: Record<string, string | undefined>;
    /** Test seams. */
    modelFactory?: ModelProviderFactory | undefined;
    agentRegistry?: (() => AgentProvider[]) | undefined;
  };
  /** Test seam for literature providers. */
  literature?: LiteratureServiceOptions;
  /** The research library (M3.2) keeps its tables in the studio database. */
  library: { db: StudioDb } & LibraryRuntimeOptions;
  /** Test seams for document processing and retrieval (M3.3). */
  documents?: DocumentRuntimeOptions;
}

export interface RuntimeApp {
  app: FastifyInstance;
  events: EventBus;
  sessions: SessionStore;
  projects: ProjectService;
  compile: CompileService;
  hub: WsHub;
  assistant: AssistantService;
  proposals: ProposalService;
  agents: AgentService;
  staging: StagingLifecycle;
  watcher: FileWatchService;
  literature: LiteratureService;
  library: LibraryRuntime;
  documents: DocumentRuntime;
  visual: VisualRuntime;
  evidence: EvidenceRuntime;
}

/** Strip query strings from logged URLs (WebSocket tickets travel in the query). */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

export async function buildApp(deps: AppDeps): Promise<RuntimeApp> {
  const app = Fastify({
    logger: deps.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  app.log.level = deps.config.logLevel;

  const events = new EventBus();
  const sessions = new SessionStore(deps.config.sessionTtlMs);
  const tickets = new TicketStore();
  const audit = new AuditService(deps.repos.audit, app.log);
  const projects = new ProjectService(deps.repos, deps.config, audit, events);
  const settings = new SettingsService(deps.repos.settings);
  const compile = new CompileService(deps.repos, projects, deps.toolchain, deps.config, events, audit, app.log);
  const watcher = new FileWatchService(projects, events, app.log);
  const hub = new WsHub(events, sessions, app.log, watcher);

  const aiRepos = createAiRepositories(deps.ai.db);
  const aiEnv = deps.ai.env ?? process.env;
  const providers = new AiProviderService(aiRepos, deps.ai.secrets, deps.config, audit, aiEnv, deps.ai.modelFactory);
  const staging = new StagingLifecycle(aiRepos, deps.config, audit, app.log);
  const agents = new AgentService(aiRepos, deps.config, events, audit, app.log, aiEnv, staging, deps.ai.agentRegistry);
  const proposals = new ProposalService(aiRepos, projects, events, audit);
  const assistant = new AssistantService(aiRepos, projects, compile, providers, agents, proposals, events, audit, deps.config, app.log);
  const literature = new LiteratureService(deps.repos, deps.ai.secrets, deps.config, audit, aiEnv, app.log, deps.literature);
  const { db: libraryDb, ...libraryOptions } = deps.library;
  const library = new LibraryRuntime(libraryDb, deps.repos, deps.ai.secrets, projects, literature, deps.config, audit, events, app.log, libraryOptions);

  const documents = new DocumentRuntime(libraryDb, deps.repos, library, deps.config, audit, events, app.log, deps.documents);

  const visual = new VisualRuntime(libraryDb, deps.config, providers, projects, library, audit, events, app.log, deps.toolchain);

  const evidence = new EvidenceRuntime(libraryDb, deps.repos, projects, documents, library, deps.config.literature.enabled ? literature : null, providers, proposals, audit, events, app.log);

  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();

  await projects.ensureWorkspace();
  staging.start();
  await library.start();
  await documents.start();
  await visual.start();
  evidence.start();
  registerErrorHandling(app, audit);
  registerRequestGuards(app, { allowedOrigins: deps.config.allowedOrigins, sessions, audit });

  app.addHook('onResponse', async (request, reply) => {
    // A rejected WebSocket upgrade owns a raw, detached socket that Node will not
    // close by itself (HTTP sockets allow half-open). Destroy it so it cannot leak.
    if (request.headers.upgrade && reply.statusCode >= 400) request.raw.socket?.destroy();
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'info' : 'debug';
    request.log[level](
      { method: request.method, url: redactUrl(request.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  await app.register(multipart, { limits: { fileSize: deps.config.maxUploadBytes, files: 1, fields: 4 } });
  await app.register(websocket, { options: { maxPayload: WS_MAX_CLIENT_MESSAGE_BYTES } });

  registerRoutes(app, {
    config: deps.config,
    pairingToken: deps.pairingToken,
    sessions,
    tickets,
    audit,
    projects,
    compile,
    settings,
    toolchain: deps.toolchain,
    hub,
    ai: { config: deps.config, secrets: deps.ai.secrets, providers, agents, assistant, proposals },
    literature,
    library,
    documents,
    visual,
    evidence,
  });

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    await evidence.stop();
    await visual.stop();
    await documents.stop();
    await library.stop();
    literature.dispose();
    await assistant.shutdown();
    await staging.stop();
    proposals.dispose();
    hub.close();
    watcher.close();
    await compile.shutdown();
  });

  return { app, events, sessions, projects, compile, hub, assistant, proposals, agents, staging, watcher, literature, library, documents, visual, evidence };
}
