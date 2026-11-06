import {
  agentTurnInstructions,
  buildContext,
  completionState,
  composeUserTurn,
  DEFAULT_CONTEXT_BUDGET,
  extractEditBlocks,
  isProviderError,
  latexWarnings,
  MAX_PROPOSED_CHARS,
  SYSTEM_PROMPT,
  validateEditBlock,
  WRITING_ACTIONS,
  type AssembledContext,
  type ChatTurn,
  type ContextBudget,
  type ContextRequest,
  type ContextSource,
  type ProjectSymbols,
  type CompletionState,
  type ProposalDraft,
  type StopReason,
} from '@research-studio/ai-core';
import type { StagingResult } from '@research-studio/agent-adapters';
import type { AiRepositories } from '@research-studio/ai-storage';
import { classifyFile } from '@research-studio/document-engine';
import {
  isStudioError,
  StudioError,
  type AgentPermissionProfile,
  type AgentRun,
  type AiMessageStatus,
  type Conversation,
  type ConversationMessage,
  type ConversationMode,
  type EditProposal,
  type TokenUsage,
  type WritingActionId,
} from '@research-studio/shared-types';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeConfig } from '../../config';
import type { EventBus } from '../../events';
import { randomId } from '../../security/tokens';
import type { AuditService } from '../audit-service';
import type { CompileService } from '../compile-service';
import type { Actor, ProjectService } from '../project-service';
import type { AgentService } from './agent-service';
import type { ProposalOrigin, ProposalService } from './proposal-service';
import { toStudioError, type AiProviderService } from './provider-service';

const DEFAULT_TITLE = 'New conversation';
/** Earlier turns sent with a model request. */
const HISTORY_MESSAGES = 16;
const HISTORY_CHARS = 40_000;
const FLUSH_MS = 1_000;
/** Why edit blocks in an answer that did not finish normally are not offered. */
const NOT_OFFERED: Record<Exclude<CompletionState, 'completed'>, string> = {
  truncated: 'the answer was cut off at the output limit, so this edit may be incomplete.',
  incomplete: 'the answer did not finish normally, so this edit may be incomplete.',
  cancelled: 'the answer was stopped before it finished.',
  failed: 'the request failed before the answer finished.',
};

/** Message status and the explanation shown to the user for each way an answer can end. */
export function describeCompletion(
  completion: CompletionState,
  stopReason: StopReason | null,
  rawReason: string | null,
  failure: string | null,
  maxOutputTokens: number,
): { status: AiMessageStatus; error: string | null } {
  switch (completion) {
    case 'completed':
      return { status: 'complete', error: null };
    case 'cancelled':
      return { status: 'cancelled', error: null };
    case 'truncated':
      return {
        status: 'truncated',
        error: `The answer reached the output limit (${maxOutputTokens.toLocaleString('en-US')} tokens) and was cut off. Suggested edits in it are not offered for review; select a shorter passage and ask again.`,
      };
    case 'incomplete':
      return {
        status: 'incomplete',
        error: `The answer ended unexpectedly (${rawReason ? `finish reason "${rawReason}"` : 'no finish reason'}). Suggested edits in it are not offered for review.`,
      };
    case 'failed':
      return { status: 'error', error: failure ?? (stopReason === 'refusal' ? 'The model declined to answer this request.' : 'The request failed.') };
  }
}

/** Agents read files themselves, so they get a smaller inline context. */
const AGENT_CONTEXT_BUDGET: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, totalChars: 24_000, wholeFileChars: 6_000, treeEntries: 120 };

export interface SendInput {
  action: WritingActionId;
  text: string;
  context: ContextRequest;
  model?: string | undefined;
  permission?: AgentPermissionProfile | undefined;
}

interface Generation {
  messageId: string;
  controller: AbortController;
  done: Promise<void>;
}

interface Turn {
  projectId: string;
  conversation: Conversation;
  assistant: ConversationMessage;
  action: WritingActionId;
  text: string;
  context: AssembledContext;
  permission: AgentPermissionProfile;
  actor: Actor;
  controller: AbortController;
}

/**
 * Conversations with API models and CLI agents. Answers stream over the
 * event bus; edit blocks and staged agent changes become proposals.
 */
export class AssistantService {
  private readonly active = new Map<string, Generation>();

  constructor(
    private readonly repos: AiRepositories,
    private readonly projects: ProjectService,
    private readonly compile: CompileService,
    private readonly providers: AiProviderService,
    private readonly agents: AgentService,
    private readonly proposals: ProposalService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly config: RuntimeConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ------------------------------------------------------------ conversations

  list(projectId: string, options: { archived?: boolean } = {}): Conversation[] {
    this.projects.get(projectId);
    return this.repos.conversations.list(projectId, options);
  }

  /** Archived conversations are kept with their messages and edits, but listed apart. */
  setArchived(projectId: string, id: string, archived: boolean, actor: Actor): Conversation {
    this.conversation(projectId, id);
    const conversation = this.repos.conversations.setArchived(projectId, id, archived)!;
    this.audit.record({ action: archived ? 'ai.conversation.archive' : 'ai.conversation.restore', outcome: 'success', actor: actor.sessionId, projectId, target: id });
    return conversation;
  }

  conversation(projectId: string, id: string): Conversation {
    const conversation = this.repos.conversations.get(projectId, id);
    if (!conversation) throw new StudioError('NOT_FOUND', 'Conversation not found');
    return conversation;
  }

  async create(
    projectId: string,
    input: { mode: ConversationMode; providerId: string; model: string | null; title?: string | undefined },
    actor: Actor,
  ): Promise<Conversation> {
    this.projects.get(projectId);
    let model = input.model;
    if (input.mode === 'model') {
      const record = this.providers.record(input.providerId);
      model ??= record.defaultModel;
      if (!model) throw new StudioError('VALIDATION_FAILED', 'Choose a model for this conversation.');
    } else {
      await this.agents.get(input.providerId);
    }
    const conversation = this.repos.conversations.create({
      id: randomId(8),
      projectId,
      mode: input.mode,
      providerId: input.providerId,
      model,
      title: input.title?.trim() || DEFAULT_TITLE,
    });
    this.audit.record({ action: 'ai.conversation.create', outcome: 'success', actor: actor.sessionId, projectId, target: conversation.id, details: { mode: input.mode, providerId: input.providerId } });
    return conversation;
  }

  detail(projectId: string, id: string): { conversation: Conversation; messages: ConversationMessage[]; proposals: EditProposal[]; runs: AgentRun[] } {
    const conversation = this.conversation(projectId, id);
    const messages = this.repos.messages.list(id);
    return {
      conversation,
      messages,
      proposals: this.repos.proposals.list(projectId, { messageIds: messages.map((m) => m.id) }),
      runs: this.repos.agentRuns.listByConversation(id),
    };
  }

  async remove(projectId: string, id: string, actor: Actor): Promise<void> {
    const conversation = this.conversation(projectId, id);
    const generation = this.active.get(id);
    if (generation) {
      generation.controller.abort();
      await generation.done;
    }
    this.repos.conversations.delete(projectId, id);
    if (conversation.mode === 'agent') await this.agents.discard(id);
    this.audit.record({ action: 'ai.conversation.delete', outcome: 'success', actor: actor.sessionId, projectId, target: id });
  }

  // ------------------------------------------------------------------ turns

  async send(projectId: string, conversationId: string, input: SendInput, actor: Actor): Promise<{ userMessage: ConversationMessage; assistantMessage: ConversationMessage }> {
    let conversation = this.conversation(projectId, conversationId);
    if (this.active.has(conversationId)) throw new StudioError('CONFLICT', 'An answer is still being generated in this conversation. Wait for it or stop it first.');
    const action = WRITING_ACTIONS[input.action];
    const text = input.text.trim();
    if (input.action === 'chat' && !text) throw new StudioError('VALIDATION_FAILED', 'Type a question first.');
    if (action.needsSelection && !input.context.selectionText?.trim()) {
      throw new StudioError('VALIDATION_FAILED', `Select some text in the editor to use “${action.label}”.`);
    }
    if (input.model && input.model !== conversation.model) {
      this.repos.conversations.update(conversationId, { model: input.model });
      conversation = { ...conversation, model: input.model };
    }
    const permission = input.permission ?? 'read';
    // Fail before recording anything when the provider or agent cannot be used.
    if (conversation.mode === 'model') await this.providers.instantiate(conversation.providerId);
    else await this.agents.assertRunnable(projectId, conversation.providerId, permission, actor);

    const context = await buildContext(await this.contextSource(projectId), input.context, conversation.mode === 'agent' ? AGENT_CONTEXT_BUDGET : DEFAULT_CONTEXT_BUDGET);
    const userMessage = this.repos.messages.append({
      id: randomId(8),
      conversationId,
      role: 'user',
      action: input.action,
      content: text || action.label,
      status: 'complete',
      context: context.items,
    });
    const assistant = this.repos.messages.append({
      id: randomId(8),
      conversationId,
      role: 'assistant',
      action: input.action,
      content: '',
      status: 'streaming',
      context: context.items,
    });
    if (conversation.title === DEFAULT_TITLE) {
      this.repos.conversations.update(conversationId, { title: (text || action.label).replace(/\s+/g, ' ').slice(0, 60) });
    }
    this.repos.conversations.touch(conversationId);
    // Continuing an archived conversation brings it back to the active list.
    if (conversation.archivedAt) this.repos.conversations.setArchived(projectId, conversationId, false);

    const controller = new AbortController();
    const turn: Turn = { projectId, conversation, assistant, action: input.action, text, context, permission, actor, controller };
    const done = (conversation.mode === 'model' ? this.runModel(turn) : this.runAgent(turn))
      .catch((err: unknown) => {
        this.log.error({ err }, 'assistant turn failed');
        this.finish(turn, { content: null, status: 'error', error: 'The request failed unexpectedly.', usage: null, editIssues: [] });
      })
      .finally(() => this.active.delete(conversationId));
    this.active.set(conversationId, { messageId: assistant.id, controller, done });
    return { userMessage, assistantMessage: assistant };
  }

  /** Stop a streaming answer. Already-received text is kept. */
  async cancel(projectId: string, messageId: string, actor: Actor): Promise<ConversationMessage> {
    const message = this.repos.messages.get(messageId);
    if (!message || !this.repos.conversations.get(projectId, message.conversationId)) throw new StudioError('NOT_FOUND', 'Message not found');
    const generation = this.active.get(message.conversationId);
    if (generation?.messageId === messageId) {
      generation.controller.abort();
      await generation.done;
      this.audit.record({ action: 'ai.cancel', outcome: 'success', actor: actor.sessionId, projectId, target: messageId });
    }
    return this.repos.messages.get(messageId)!;
  }

  async shutdown(): Promise<void> {
    const pending = [...this.active.values()];
    for (const g of pending) g.controller.abort();
    await Promise.allSettled(pending.map((g) => g.done));
  }

  // ------------------------------------------------------------- model turn

  private async runModel(turn: Turn): Promise<void> {
    const { record, provider } = await this.providers.instantiate(turn.conversation.providerId);
    const model = turn.conversation.model ?? record.defaultModel;
    if (!model) throw new StudioError('VALIDATION_FAILED', 'No model selected.');
    const messages: ChatTurn[] = [...this.history(turn), { role: 'user', content: composeUserTurn(turn.action, turn.text, turn.context).userTurn }];
    const timeout = AbortSignal.timeout(this.config.ai.requestTimeoutMs);
    const signal = AbortSignal.any([turn.controller.signal, timeout]);
    const stream = this.streamer(turn);
    let usage: TokenUsage | null = null;
    let stopReason: StopReason | null = null;
    let rawReason: string | null = null;
    let failure: string | null = null;
    try {
      for await (const event of provider.stream({ model, system: SYSTEM_PROMPT, messages, maxOutputTokens: this.config.ai.maxOutputTokens, signal })) {
        if (event.type === 'text-delta') stream.push(event.text);
        else if (event.type === 'usage') usage = event.usage;
        else {
          stopReason = event.stopReason;
          rawReason = event.rawReason;
        }
      }
    } catch (err) {
      if (!turn.controller.signal.aborted) {
        failure = timeout.aborted
          ? `The model did not finish within ${Math.round(this.config.ai.requestTimeoutMs / 1000)} seconds.`
          : isProviderError(err) && err.code === 'cancelled'
            ? 'The request was cancelled.'
            : toStudioError(err).message;
      }
    }
    stream.flush();
    const completion = completionState({ stopReason, cancelled: turn.controller.signal.aborted, error: failure !== null });
    const { status, error } = describeCompletion(completion, stopReason, rawReason, failure, this.config.ai.maxOutputTokens);

    // Only a normally finished answer can propose edits. Anything else keeps
    // its text for reading, and its edit blocks are listed as not offered.
    const editIssues =
      completion === 'completed'
        ? await this.proposalsFromText(turn, stream.content, null)
        : extractEditBlocks(stream.content).map(({ index }) => ({ index, problem: NOT_OFFERED[completion] }));
    this.finish(turn, { content: stream.content, status, error, usage, editIssues, finishReason: rawReason });
    this.audit.record({
      action: 'ai.request',
      outcome: status === 'error' ? 'error' : 'success',
      actor: turn.actor.sessionId,
      projectId: turn.projectId,
      target: record.id,
      details: {
        kind: record.kind,
        model,
        action: turn.action,
        status,
        finishReason: rawReason,
        context: turn.context.items.map((i) => ({ kind: i.kind, chars: i.chars })),
        outputTokens: usage?.outputTokens ?? null,
      },
    });
  }

  /** Earlier complete exchanges, newest last, within a size budget. */
  private history(turn: Turn): ChatTurn[] {
    const all = this.repos.messages.list(turn.conversation.id).filter((m) => m.id !== turn.assistant.id);
    const pairs: ChatTurn[][] = [];
    for (let i = 0; i < all.length - 1; i++) {
      const user = all[i]!;
      const answer = all[i + 1]!;
      if (user.role === 'user' && answer.role === 'assistant' && answer.status === 'complete' && answer.content.trim()) {
        pairs.push([
          { role: 'user', content: user.content },
          { role: 'assistant', content: answer.content },
        ]);
        i++;
      }
    }
    const kept: ChatTurn[][] = [];
    let chars = 0;
    for (const pair of pairs.reverse()) {
      const size = pair[0]!.content.length + pair[1]!.content.length;
      if (kept.length * 2 >= HISTORY_MESSAGES || chars + size > HISTORY_CHARS) break;
      kept.unshift(pair);
      chars += size;
    }
    return kept.flat();
  }

  // ------------------------------------------------------------- agent turn

  private async runAgent(turn: Turn): Promise<void> {
    const { project } = await this.projects.open(turn.projectId);
    const agent = await this.agents.get(turn.conversation.providerId);
    const stream = this.streamer(turn);
    const prompt = [agentTurnInstructions(turn.permission), composeUserTurn(turn.action, turn.text, turn.context).userTurn].join('\n\n');
    const result = await this.agents.run({
      projectId: turn.projectId,
      projectRoot: project.rootPath,
      conversationId: turn.conversation.id,
      messageId: turn.assistant.id,
      agentId: agent.id,
      permission: turn.permission,
      model: turn.conversation.model,
      resumeSessionId: agent.capabilities.resume ? this.repos.conversations.agentSessionId(turn.conversation.id) : null,
      prompt,
      signal: turn.controller.signal,
      actor: turn.actor,
      onText: (text) => stream.push(text),
    });
    stream.flush();
    if (result.sessionId) this.repos.conversations.update(turn.conversation.id, { agentSessionId: result.sessionId });
    const status: AiMessageStatus = result.status === 'completed' ? 'complete' : result.status === 'cancelled' ? 'cancelled' : 'error';
    let error = result.error;
    if (result.status === 'timed-out') error = `${agent.displayName} exceeded its time limit and was stopped.`;
    const editIssues = status === 'complete' ? await this.proposalsFromText(turn, stream.content, result.run.id) : [];
    if (result.staged) editIssues.push(...(await this.proposalsFromStaging(turn, result.staged, result.run.id, agent.displayName)));
    this.finish(turn, { content: stream.content.trim(), status, error, usage: result.usage, editIssues });
  }

  // ---------------------------------------------------------------- helpers

  private streamer(turn: Turn) {
    let content = '';
    let lastFlush = Date.now();
    const flush = () => {
      this.repos.messages.update(turn.assistant.id, { content });
      lastFlush = Date.now();
    };
    return {
      get content() {
        return content;
      },
      push: (text: string) => {
        if (!text) return;
        content += text;
        this.events.publish({ type: 'ai.message.delta', projectId: turn.projectId, conversationId: turn.conversation.id, messageId: turn.assistant.id, text });
        if (Date.now() - lastFlush > FLUSH_MS) flush();
      },
      flush,
    };
  }

  private finish(
    turn: Turn,
    result: {
      content: string | null;
      status: AiMessageStatus;
      error: string | null;
      usage: TokenUsage | null;
      editIssues: { index: number; problem: string }[];
      finishReason?: string | null;
    },
  ): void {
    this.repos.messages.update(turn.assistant.id, {
      ...(result.content !== null ? { content: result.content } : {}),
      status: result.status,
      error: result.error,
      usage: result.usage,
      editIssues: result.editIssues,
      finishReason: result.finishReason ?? null,
    });
    this.repos.conversations.touch(turn.conversation.id);
    const message = this.repos.messages.get(turn.assistant.id);
    if (message) this.events.publish({ type: 'ai.message.updated', projectId: turn.projectId, message });
  }

  private origin(turn: Turn, agentRunId: string | null, source: 'model' | 'agent'): ProposalOrigin {
    return { conversationId: turn.conversation.id, messageId: turn.assistant.id, agentRunId, source, action: turn.action };
  }

  /** Validate every edit block in an answer against the real files. */
  private async proposalsFromText(turn: Turn, content: string, agentRunId: string | null): Promise<{ index: number; problem: string }[]> {
    const blocks = extractEditBlocks(content);
    if (!blocks.length) return [];
    const issues: { index: number; problem: string }[] = [];
    const symbols = await this.symbols(turn.projectId);
    for (const { index, block, problem } of blocks) {
      if (!block) {
        issues.push({ index, problem: problem ?? 'Malformed edit block.' });
        continue;
      }
      const result = await validateEditBlock(block, {
        selection: turn.context.selection,
        readFile: async (file) => {
          const current = await this.proposals.current(turn.projectId, file);
          return current ? { path: file, ...current } : null;
        },
        symbols,
      });
      if (result.ok) this.proposals.create(turn.projectId, this.origin(turn, agentRunId, agentRunId ? 'agent' : 'model'), result.draft, index);
      else issues.push({ index, problem: result.problem });
    }
    return issues;
  }

  private async proposalsFromStaging(turn: Turn, staged: StagingResult, runId: string, agentName: string): Promise<{ index: number; problem: string }[]> {
    const issues = staged.ignored.map((i) => ({ index: -1, problem: `${i.path}: ${i.reason}` }));
    if (!staged.changes.length) return issues;
    const symbols = await this.symbols(turn.projectId);
    for (const change of staged.changes) {
      let draft: ProposalDraft;
      if (change.change === 'update') {
        draft = {
          file: change.path,
          changeType: 'modify',
          baseHash: change.baseHash,
          original: change.before,
          proposed: change.after,
          range: null,
          explanation: `Edited by ${agentName}.`,
          warnings: latexWarnings(change.before, change.after, symbols),
        };
      } else if (change.change === 'add') {
        draft = { file: change.path, changeType: 'create', baseHash: null, original: '', proposed: change.after, range: null, explanation: `Created by ${agentName}.`, warnings: [] };
      } else {
        draft = { file: change.path, changeType: 'delete', baseHash: change.baseHash, original: change.before, proposed: '', range: null, explanation: `Deleted by ${agentName}.`, warnings: [] };
      }
      if (draft.proposed.length > MAX_PROPOSED_CHARS) {
        issues.push({ index: -1, problem: `${change.path}: the change is too large to review` });
        continue;
      }
      this.proposals.create(turn.projectId, this.origin(turn, runId, 'agent'), draft, null);
    }
    return issues;
  }

  private async symbols(projectId: string): Promise<ProjectSymbols> {
    const { labels, citations } = await this.projects.symbols(projectId);
    return { labels: new Set(labels.map((l) => l.label)), citationKeys: new Set(citations.map((c) => c.key)) };
  }

  private async contextSource(projectId: string): Promise<ContextSource> {
    const { project, fs } = await this.projects.open(projectId);
    const job = this.compile.listJobs(projectId).find((j) => j.finishedAt !== null);
    return {
      mainFile: project.mainFile,
      readText: async (file) => {
        try {
          const { content, hash } = await fs.readText(file);
          return { content, hash };
        } catch (err) {
          if (isStudioError(err) && ['NOT_FOUND', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE'].includes(err.code)) return null;
          throw err;
        }
      },
      listFiles: async () => (await fs.listFiles()).map((f) => ({ path: f.path, kind: f.kind ?? classifyFile(f.path), size: f.size ?? null })),
      diagnostics: () => job?.diagnostics ?? [],
    };
  }
}
