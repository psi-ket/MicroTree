import type { FastifyInstance } from 'fastify';
import {
  AcceptProposalRequest,
  AgentListQuery,
  ConversationListQuery,
  ConversationParams,
  CreateConversationRequest,
  CreateProviderRequest,
  MessageParams,
  ProjectParams,
  ProposalListQuery,
  ProposalParams,
  ProviderParams,
  SendMessageRequest,
  SetAgentApprovalRequest,
  UpdateConversationRequest,
  UpdateProviderRequest,
} from '@research-studio/api-contracts';
import type { SecretStore } from '@research-studio/ai-storage';
import type { RuntimeConfig } from './config';
import { actorOf, parse } from './http';
import type { AgentService } from './services/ai/agent-service';
import type { AssistantService } from './services/ai/assistant-service';
import type { ProposalService } from './services/ai/proposal-service';
import type { AiProviderService } from './services/ai/provider-service';

export interface AiRouteDeps {
  config: RuntimeConfig;
  secrets: SecretStore;
  providers: AiProviderService;
  agents: AgentService;
  assistant: AssistantService;
  proposals: ProposalService;
}

/** AI routes, registered inside the authenticated `/api/v1` scope. */
export function registerAiRoutes(api: FastifyInstance, deps: AiRouteDeps): void {
  const { config, providers, agents, assistant, proposals } = deps;

  // -------------------------------------------------------------- providers
  api.get('/ai/status', async () => ({
    secretStore: { kind: deps.secrets.kind, notice: deps.secrets.notice },
    agentsEnabled: agents.enabled,
    limits: { maxOutputTokens: config.ai.maxOutputTokens, requestTimeoutMs: config.ai.requestTimeoutMs, agentTimeoutMs: config.ai.agentTimeoutMs },
  }));

  api.get('/ai/providers', async () => ({ providers: await providers.list() }));

  api.post('/ai/providers', async (request, reply) => {
    const input = parse(CreateProviderRequest, request.body);
    return reply.code(201).send({ provider: await providers.create(input, actorOf(request)) });
  });

  api.patch('/ai/providers/:providerId', async (request) => {
    const { providerId } = parse(ProviderParams, request.params);
    const patch = parse(UpdateProviderRequest, request.body);
    return { provider: await providers.update(providerId, patch, actorOf(request)) };
  });

  api.delete('/ai/providers/:providerId', async (request, reply) => {
    const { providerId } = parse(ProviderParams, request.params);
    await providers.delete(providerId, actorOf(request));
    return reply.code(204).send();
  });

  api.get('/ai/providers/:providerId/models', async (request) => {
    const { providerId } = parse(ProviderParams, request.params);
    return { models: await providers.listModels(providerId) };
  });

  // ----------------------------------------------------------------- agents
  api.get('/ai/agents', async (request) => {
    const { refresh } = parse(AgentListQuery, request.query);
    return { agents: await agents.list(refresh === '1') };
  });

  api.get('/projects/:projectId/ai/agent-approvals', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    assistant.list(projectId); // 404 for unknown projects
    return { approvals: agents.approvals(projectId) };
  });

  api.put('/projects/:projectId/ai/agent-approvals', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    const input = parse(SetAgentApprovalRequest, request.body);
    assistant.list(projectId);
    return { approvals: await agents.setApproval(projectId, input.agentId, input.permission, input.approved, actorOf(request)) };
  });

  // ---------------------------------------------------------- conversations
  api.get('/projects/:projectId/ai/conversations', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    const { archived } = parse(ConversationListQuery, request.query);
    return { conversations: assistant.list(projectId, { archived }) };
  });

  api.post('/projects/:projectId/ai/conversations', async (request, reply) => {
    const { projectId } = parse(ProjectParams, request.params);
    const input = parse(CreateConversationRequest, request.body);
    return reply.code(201).send({ conversation: await assistant.create(projectId, input, actorOf(request)) });
  });

  api.get('/projects/:projectId/ai/conversations/:conversationId', async (request) => {
    const { projectId, conversationId } = parse(ConversationParams, request.params);
    return assistant.detail(projectId, conversationId);
  });

  api.patch('/projects/:projectId/ai/conversations/:conversationId', async (request) => {
    const { projectId, conversationId } = parse(ConversationParams, request.params);
    const { archived } = parse(UpdateConversationRequest, request.body);
    return { conversation: assistant.setArchived(projectId, conversationId, archived, actorOf(request)) };
  });

  api.delete('/projects/:projectId/ai/conversations/:conversationId', async (request, reply) => {
    const { projectId, conversationId } = parse(ConversationParams, request.params);
    await assistant.remove(projectId, conversationId, actorOf(request));
    return reply.code(204).send();
  });

  api.post('/projects/:projectId/ai/conversations/:conversationId/messages', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const { projectId, conversationId } = parse(ConversationParams, request.params);
    const input = parse(SendMessageRequest, request.body);
    return reply.code(202).send(await assistant.send(projectId, conversationId, input, actorOf(request)));
  });

  api.post('/projects/:projectId/ai/messages/:messageId/cancel', async (request) => {
    const { projectId, messageId } = parse(MessageParams, request.params);
    return { message: await assistant.cancel(projectId, messageId, actorOf(request)) };
  });

  // -------------------------------------------------------------- proposals
  api.get('/projects/:projectId/ai/proposals', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    const { status } = parse(ProposalListQuery, request.query);
    return { proposals: proposals.list(projectId, status) };
  });

  api.get('/projects/:projectId/ai/proposals/:proposalId/preview', async (request) => {
    const { projectId, proposalId } = parse(ProposalParams, request.params);
    return proposals.preview(projectId, proposalId);
  });

  api.post('/projects/:projectId/ai/proposals/:proposalId/accept', { bodyLimit: 24 * 1024 * 1024 }, async (request) => {
    const { projectId, proposalId } = parse(ProposalParams, request.params);
    const { content } = parse(AcceptProposalRequest, request.body ?? {});
    return { proposal: await proposals.accept(projectId, proposalId, content, actorOf(request)) };
  });

  api.post('/projects/:projectId/ai/proposals/:proposalId/reject', async (request) => {
    const { projectId, proposalId } = parse(ProposalParams, request.params);
    return { proposal: proposals.reject(projectId, proposalId, actorOf(request)) };
  });

  api.post('/projects/:projectId/ai/proposals/:proposalId/revert', async (request) => {
    const { projectId, proposalId } = parse(ProposalParams, request.params);
    return { proposal: await proposals.revert(projectId, proposalId, actorOf(request)) };
  });
}
