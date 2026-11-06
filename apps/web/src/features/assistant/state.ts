import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import type { RuntimeClient } from '@research-studio/api-contracts';
import type { AgentActivity, AgentPermissionProfile, AgentRun } from '@research-studio/shared-types';
import { runtime, useConnection } from '../../lib/connection';
import { local } from '../../lib/storage';
import { useEditor } from '../../stores/editor';

// ------------------------------------------------------------------ queries

export const aiKeys = {
  status: ['ai', 'status'] as const,
  providers: ['ai', 'providers'] as const,
  agents: ['ai', 'agents'] as const,
  models: (providerId: string) => ['ai', 'models', providerId] as const,
  approvals: (projectId: string) => ['ai', 'approvals', projectId] as const,
  conversations: (projectId: string) => ['ai', 'conversations', projectId] as const,
  archivedConversations: (projectId: string) => ['ai', 'conversations', projectId, 'archived'] as const,
  conversation: (projectId: string, id: string) => ['ai', 'conversation', projectId, id] as const,
  preview: (projectId: string, id: string) => ['ai', 'preview', projectId, id] as const,
};

const useConnected = () => useConnection((s) => s.status === 'connected');

export const useAiStatus = () => useQuery({ queryKey: aiKeys.status, queryFn: () => runtime().ai.status(), enabled: useConnected(), staleTime: 60_000 });

export const useProviders = () =>
  useQuery({ queryKey: aiKeys.providers, queryFn: async () => (await runtime().ai.listProviders()).providers, enabled: useConnected() });

export const useAgents = () =>
  useQuery({ queryKey: aiKeys.agents, queryFn: async () => (await runtime().ai.listAgents()).agents, enabled: useConnected(), staleTime: 5 * 60_000 });

export const useModels = (providerId: string | null) =>
  useQuery({
    queryKey: aiKeys.models(providerId ?? ''),
    queryFn: async () => (await runtime().ai.listModels(providerId!)).models,
    enabled: !!providerId,
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useApprovals = (projectId: string) =>
  useQuery({ queryKey: aiKeys.approvals(projectId), queryFn: async () => (await runtime().ai.agentApprovals(projectId)).approvals });

export const useConversations = (projectId: string) =>
  useQuery({ queryKey: aiKeys.conversations(projectId), queryFn: async () => (await runtime().ai.listConversations(projectId)).conversations });

export const useArchivedConversations = (projectId: string) =>
  useQuery({ queryKey: aiKeys.archivedConversations(projectId), queryFn: async () => (await runtime().ai.listConversations(projectId, { archived: true })).conversations });

export const useConversation = (projectId: string, id: string | null) =>
  useQuery({
    queryKey: aiKeys.conversation(projectId, id ?? ''),
    queryFn: () => runtime().ai.getConversation(projectId, id!),
    enabled: !!id,
    staleTime: 5_000,
  });

// -------------------------------------------------------------- live state

/** A model provider (`model:<id>`) or a CLI agent (`agent:<id>`). */
export type Target = `model:${string}` | `agent:${string}`;

export const parseTarget = (t: Target | null) => {
  if (!t) return null;
  const [mode, ...rest] = t.split(':');
  return { mode: mode as 'model' | 'agent', id: rest.join(':') };
};

const TARGET_KEY = 'rs.ai.target';
const PERMISSION_KEY = 'rs.ai.permission';

interface AssistantState {
  /** Open conversation per project. */
  conversation: Record<string, string | null>;
  target: Target | null;
  model: string;
  permission: AgentPermissionProfile;
  /** Text received over the socket for messages still streaming. */
  streaming: Record<string, string>;
  /** Latest agent run and recent activity per conversation. */
  runs: Record<string, AgentRun>;
  activity: Record<string, AgentActivity[]>;
  reviewing: string | null;
  setupOpen: boolean;

  open(projectId: string, conversationId: string | null): void;
  setTarget(target: Target | null, model?: string): void;
  setModel(model: string): void;
  setPermission(permission: AgentPermissionProfile): void;
  appendDelta(messageId: string, text: string): void;
  endStream(messageId: string): void;
  agentEvent(conversationId: string, run: AgentRun | null, activity: AgentActivity | null): void;
  review(proposalId: string | null): void;
  setSetupOpen(open: boolean): void;
}

const MAX_ACTIVITY = 40;

export const useAssistant = create<AssistantState>((set) => ({
  conversation: {},
  target: (local.get(TARGET_KEY) as Target | null) ?? null,
  model: '',
  permission: local.get(PERMISSION_KEY) === 'write-staged' ? 'write-staged' : 'read',
  streaming: {},
  runs: {},
  activity: {},
  reviewing: null,
  setupOpen: false,

  open: (projectId, conversationId) => set((s) => ({ conversation: { ...s.conversation, [projectId]: conversationId } })),
  setTarget: (target, model) => {
    if (target) local.set(TARGET_KEY, target);
    else local.remove(TARGET_KEY);
    set({ target, model: model ?? '' });
  },
  setModel: (model) => set({ model }),
  setPermission: (permission) => {
    local.set(PERMISSION_KEY, permission);
    set({ permission });
  },
  appendDelta: (messageId, text) => set((s) => ({ streaming: { ...s.streaming, [messageId]: (s.streaming[messageId] ?? '') + text } })),
  endStream: (messageId) =>
    set((s) => {
      if (!(messageId in s.streaming)) return s;
      const { [messageId]: _done, ...streaming } = s.streaming;
      return { streaming };
    }),
  agentEvent: (conversationId, run, activity) =>
    set((s) => ({
      runs: run ? { ...s.runs, [conversationId]: run } : s.runs,
      activity: activity ? { ...s.activity, [conversationId]: [...(s.activity[conversationId] ?? []), activity].slice(-MAX_ACTIVITY) } : s.activity,
    })),
  review: (proposalId) => set({ reviewing: proposalId }),
  setSetupOpen: (setupOpen) => set({ setupOpen }),
}));

// ----------------------------------------------------------------- context

export type ContextRequest = Parameters<RuntimeClient['ai']['sendMessage']>[2]['context'];

/** What the editor tells the runtime; the runtime reads the files itself. */
export function currentContext(): ContextRequest {
  const { active, tabs, selection, cursor } = useEditor.getState();
  const sel = selection && selection.file === active && selection.text.length <= 200_000 ? selection : null;
  return {
    activeFile: active,
    selection: sel ? { file: sel.file, startLine: sel.fromLine, startColumn: sel.startColumn, endLine: sel.toLine, endColumn: sel.endColumn } : null,
    selectionText: sel?.text ?? null,
    cursor,
    openTabs: tabs.slice(0, 50),
    attachedFiles: [],
  };
}
