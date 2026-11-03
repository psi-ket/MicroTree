import { toast } from 'sonner';
import type { RuntimeClient } from '@research-studio/api-contracts';
import type { ConversationMessage, EditProposal, WritingActionId } from '@research-studio/shared-types';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { isDirty, useEditor } from '../../stores/editor';
import { compileProject, saveAll } from '../workspace/actions';
import { aiKeys, currentContext, parseTarget, useAssistant } from './state';

type Detail = Awaited<ReturnType<RuntimeClient['ai']['getConversation']>>;

function patchDetail(projectId: string, conversationId: string, fn: (d: Detail) => Detail) {
  queryClient.setQueryData<Detail>(aiKeys.conversation(projectId, conversationId), (d) => (d ? fn(d) : d));
}

export function upsertMessage(projectId: string, message: ConversationMessage) {
  patchDetail(projectId, message.conversationId, (d) => {
    const exists = d.messages.some((m) => m.id === message.id);
    return { ...d, messages: exists ? d.messages.map((m) => (m.id === message.id ? message : m)) : [...d.messages, message] };
  });
}

export function upsertProposal(proposal: EditProposal) {
  if (!proposal.conversationId) return;
  patchDetail(proposal.projectId, proposal.conversationId, (d) => {
    const exists = d.proposals.some((p) => p.id === proposal.id);
    return { ...d, proposals: exists ? d.proposals.map((p) => (p.id === proposal.id ? proposal : p)) : [...d.proposals, proposal] };
  });
  void queryClient.invalidateQueries({ queryKey: aiKeys.preview(proposal.projectId, proposal.id) });
}

/** Re-read an open, unmodified buffer after the runtime changed its file. */
async function reloadBuffer(projectId: string, path: string) {
  const buffer = useEditor.getState().buffers[path];
  if (!buffer || isDirty(buffer)) return;
  try {
    const file = await runtime().readFile(projectId, path);
    useEditor.getState().replaceFromDisk(file);
  } catch {
    useEditor.getState().removePath(path);
  }
}

/** Send a request with the current editor context, starting a conversation when needed. */
export async function ask(projectId: string, action: WritingActionId, text: string): Promise<boolean> {
  const state = useAssistant.getState();
  const target = parseTarget(state.target);
  if (!target) {
    state.setSetupOpen(true);
    return false;
  }
  // The runtime reads files from disk, so unsaved edits must be written first.
  if (!(await saveAll())) {
    toast.error('Save your files first', { description: 'Some files could not be saved, so the assistant would see stale text.' });
    return false;
  }
  try {
    const ai = runtime().ai;
    let conversationId = state.conversation[projectId] ?? null;
    const current = conversationId ? queryClient.getQueryData<Detail>(aiKeys.conversation(projectId, conversationId)) : undefined;
    const model = state.model.trim() || null;
    if (!current || current.conversation.mode !== target.mode || current.conversation.providerId !== target.id) {
      const { conversation } = await ai.createConversation(projectId, { mode: target.mode, providerId: target.id, model });
      conversationId = conversation.id;
      queryClient.setQueryData<Detail>(aiKeys.conversation(projectId, conversation.id), { conversation, messages: [], proposals: [], runs: [] });
      state.open(projectId, conversation.id);
    }
    const res = await ai.sendMessage(projectId, conversationId!, {
      action,
      text,
      context: currentContext(),
      ...(model && model !== current?.conversation.model ? { model } : {}),
      ...(target.mode === 'agent' ? { permission: state.permission } : {}),
    });
    upsertMessage(projectId, res.userMessage);
    upsertMessage(projectId, res.assistantMessage);
    void queryClient.invalidateQueries({ queryKey: aiKeys.conversations(projectId) });
    return true;
  } catch (err) {
    toast.error('The assistant could not start', { description: errorMessage(err) });
    return false;
  }
}

export async function stop(projectId: string, messageId: string) {
  try {
    const { message } = await runtime().ai.cancelMessage(projectId, messageId);
    useAssistant.getState().endStream(messageId);
    upsertMessage(projectId, message);
  } catch (err) {
    toast.error('Could not stop the answer', { description: errorMessage(err) });
  }
}

export async function acceptProposal(projectId: string, proposal: EditProposal, content?: string): Promise<boolean> {
  if (!(await saveAll())) {
    toast.error('Save your files first', { description: 'The edit is applied to the saved file.' });
    return false;
  }
  try {
    const { proposal: accepted } = await runtime().ai.acceptProposal(projectId, proposal.id, content === undefined ? {} : { content });
    upsertProposal(accepted);
    await reloadBuffer(projectId, accepted.file);
    toast.success(`Applied to ${accepted.file}`, { action: { label: 'Compile', onClick: () => void compileProject() } });
    return true;
  } catch (err) {
    toast.error('The edit was not applied', { description: errorMessage(err) });
    void queryClient.invalidateQueries({ queryKey: aiKeys.conversation(projectId, proposal.conversationId ?? '') });
    return false;
  }
}

export async function rejectProposal(projectId: string, proposal: EditProposal) {
  try {
    upsertProposal((await runtime().ai.rejectProposal(projectId, proposal.id)).proposal);
  } catch (err) {
    toast.error('Could not reject the edit', { description: errorMessage(err) });
  }
}

export async function revertProposal(projectId: string, proposal: EditProposal) {
  if (!(await saveAll())) return;
  try {
    const { proposal: reverted } = await runtime().ai.revertProposal(projectId, proposal.id);
    upsertProposal(reverted);
    await reloadBuffer(projectId, reverted.file);
    toast.success(`Reverted ${reverted.file}`);
  } catch (err) {
    toast.error('Could not revert the edit', { description: errorMessage(err) });
  }
}
