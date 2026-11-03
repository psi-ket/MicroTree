import { ChevronDown, ChevronRight, Plus, SendHorizontal, Settings2, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { WRITING_ACTIONS } from '@research-studio/ai-core';
import { WRITING_ACTION_IDS, type WritingActionId } from '@research-studio/shared-types';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, PanelHeading, Select } from '@research-studio/ui';
import { useCompile } from '../../stores/compile';
import { useEditor } from '../../stores/editor';
import { useLayout } from '../../stores/layout';
import { ask, stop } from './actions';
import { MessageView } from './Message';
import { ReviewDialog } from './ReviewDialog';
import { SetupDialog } from './SetupDialog';
import {
  parseTarget,
  useAgents,
  useApprovals,
  useAssistant,
  useConversation,
  useConversations,
  useModels,
  useProviders,
  type Target,
} from './state';

/** Shown as chips; the other actions sit in the "More" menu. */
const PRIMARY: WritingActionId[] = ['explain', 'improve-wording', 'concise', 'diagnose-errors'];
const SECONDARY = WRITING_ACTION_IDS.filter((id) => id !== 'chat' && !PRIMARY.includes(id)).map((id) => WRITING_ACTIONS[id]);

function ActionBar({ disabled, hasSelection, onRun }: { disabled: boolean; hasSelection: boolean; onRun: (id: WritingActionId) => void }) {
  const unavailable = (id: WritingActionId) => disabled || (WRITING_ACTIONS[id].needsSelection && !hasSelection);
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Writing actions">
      {PRIMARY.map((id) => (
        <button
          key={id}
          type="button"
          disabled={unavailable(id)}
          title={WRITING_ACTIONS[id].needsSelection && !hasSelection ? 'Select text in the editor first' : WRITING_ACTIONS[id].label}
          onClick={() => onRun(id)}
          className="rounded-full border border-rule bg-raised px-2 py-px text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-40"
        >
          {WRITING_ACTIONS[id].label}
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className="inline-flex items-center gap-0.5 rounded-full border border-rule bg-raised py-px pl-2 pr-1.5 text-[11px] text-ink-muted hover:border-accent hover:text-accent disabled:opacity-40"
        >
          More <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {SECONDARY.map((a) => (
            <DropdownMenuItem key={a.id} disabled={unavailable(a.id)} onSelect={() => onRun(a.id)}>
              {a.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ContextChips({ projectId }: { projectId: string }) {
  const { active, selection } = useEditor();
  const problems = useCompile((s) => s.jobs[projectId]?.diagnostics.length ?? 0);
  const chips = [
    active ? { label: active, title: 'Active file' } : null,
    selection && selection.file === active
      ? { label: selection.fromLine === selection.toLine ? `line ${selection.fromLine} selected` : `lines ${selection.fromLine}–${selection.toLine} selected`, title: `${selection.text.length} characters` }
      : null,
    problems ? { label: `${problems} problem${problems === 1 ? '' : 's'}`, title: 'From the last compile' } : null,
  ].filter((c): c is { label: string; title: string } => c !== null);
  if (!chips.length) return <p className="text-2xs text-ink-faint">Open a file to give the assistant context.</p>;
  return (
    <div className="flex flex-wrap gap-1" data-testid="context-chips">
      {chips.map((c) => (
        <span key={c.label} title={c.title} className="max-w-full truncate rounded-[3px] border border-rule bg-paper px-1.5 font-mono text-[10.5px] leading-[18px] text-ink-muted">
          {c.label}
        </span>
      ))}
    </div>
  );
}

function TargetPicker({ projectId }: { projectId: string }) {
  const { target, setTarget, model, setModel, permission, setPermission, setSetupOpen } = useAssistant();
  const { data: providers = [] } = useProviders();
  const { data: agents = [] } = useAgents();
  const { data: approvals = [] } = useApprovals(projectId);
  const parsed = parseTarget(target);
  const provider = parsed?.mode === 'model' ? providers.find((p) => p.id === parsed.id) : undefined;
  const agent = parsed?.mode === 'agent' ? agents.find((a) => a.id === parsed.id) : undefined;
  const models = useModels(provider?.id ?? null);
  const approved = agent ? approvals.some((a) => a.agentId === agent.id && a.permission === permission) : true;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Select
          aria-label="Assistant"
          className="min-w-0 flex-1"
          value={target ?? ''}
          onChange={(e) => {
            if (e.target.value === '__setup') return setSetupOpen(true);
            const next = (e.target.value || null) as Target | null;
            const p = next?.startsWith('model:') ? providers.find((x) => `model:${x.id}` === next) : undefined;
            setTarget(next, p?.defaultModel ?? '');
          }}
        >
          <option value="">Choose an assistant…</option>
          {providers.some((p) => p.enabled) ? (
            <optgroup label="Models">
              {providers.filter((p) => p.enabled).map((p) => (
                <option key={p.id} value={`model:${p.id}`}>
                  {p.displayName}
                </option>
              ))}
            </optgroup>
          ) : null}
          {agents.some((a) => a.available) ? (
            <optgroup label="Agents">
              {agents.filter((a) => a.available).map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  {a.displayName}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value="__setup">Set up…</option>
        </Select>
        {agent ? (
          <Select aria-label="Agent permissions" className="w-[118px]" value={permission} onChange={(e) => setPermission(e.target.value as typeof permission)}>
            {agent.capabilities.permissionProfiles.includes('read') ? <option value="read">Read only</option> : null}
            {agent.capabilities.permissionProfiles.includes('write-staged') ? <option value="write-staged">Edit a copy</option> : null}
          </Select>
        ) : null}
      </div>
      {provider || agent?.capabilities.modelSelection ? (
        <>
          <input
            aria-label="Model"
            list="rs-model-list"
            value={model}
            placeholder={provider?.defaultModel ?? 'Agent default model'}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            className="h-6 w-full rounded-ctl border border-rule bg-raised px-2 font-mono text-2xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <datalist id="rs-model-list">
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </>
      ) : null}
      {provider && provider.credential.required && !provider.credential.configured ? (
        <p className="text-2xs text-warning">
          {provider.displayName} has no API key.{' '}
          <button type="button" className="underline" onClick={() => setSetupOpen(true)}>
            Add one
          </button>
        </p>
      ) : null}
      {agent && !approved ? (
        <p className="text-2xs text-warning" data-testid="agent-approval-needed">
          {agent.displayName} is not allowed in this project yet.{' '}
          <button type="button" className="underline" onClick={() => setSetupOpen(true)}>
            Review permissions
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function AssistantPanel({ projectId }: { projectId: string }) {
  const toggle = useLayout((s) => s.toggle);
  const { conversation: open, open: openConversation, target, setTarget, setSetupOpen } = useAssistant();
  const activity = useAssistant((s) => s.activity);
  const conversationId = open[projectId] ?? null;
  const { data: conversations = [] } = useConversations(projectId);
  const { data: detail } = useConversation(projectId, conversationId);
  const { data: providers, isSuccess: providersLoaded } = useProviders();
  const hasSelection = useEditor((s) => !!s.selection && s.selection.file === s.active);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => detail?.messages ?? [], [detail]);
  const streamingMessage = messages.find((m) => m.status === 'streaming');
  const live = useAssistant((s) => (streamingMessage ? s.streaming[streamingMessage.id]?.length : 0));

  // Keep the newest text in view while answers stream.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live, detail?.proposals.length]);

  const send = async (action: WritingActionId) => {
    setSending(true);
    const ok = await ask(projectId, action, text);
    setSending(false);
    if (ok) setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (text.trim() && !streamingMessage) void send('chat');
    }
  };

  const noSetup = providersLoaded && !providers.length && !target;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper" aria-label="Assistant" data-testid="assistant-panel">
      <PanelHeading className="gap-0.5 pr-1.5">
        <span>Assistant</span>
        <Select
          aria-label="Conversation history"
          className="ml-2 h-6 min-w-0 flex-1 text-2xs"
          value={conversationId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            openConversation(projectId, id);
            const c = conversations.find((x) => x.id === id);
            if (c) setTarget(`${c.mode}:${c.providerId}` as Target, c.model ?? '');
          }}
        >
          <option value="">New conversation</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="icon-sm" aria-label="New conversation" onClick={() => openConversation(projectId, null)}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Assistant setup" onClick={() => setSetupOpen(true)}>
          <Settings2 />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Hide assistant" onClick={() => toggle('assistant', false)}>
          <ChevronRight />
        </Button>
      </PanelHeading>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-3 pb-3" data-testid="assistant-messages">
        {messages.length === 0 ? (
          noSetup ? (
            <div className="pt-2">
              <p className="font-display text-[17px] italic leading-6 text-ink">No assistant connected</p>
              <p className="mt-1.5 text-ui text-ink-muted">
                Connect a model service or a command-line agent. Requests go through your local runtime; your API keys never reach this browser.
              </p>
              <Button className="mt-3" variant="primary" onClick={() => setSetupOpen(true)}>
                Set up the assistant
              </Button>
            </div>
          ) : (
            <div className="pt-2">
              <p className="font-display text-[17px] italic leading-6 text-ink">Ask about your manuscript</p>
              <p className="mt-1.5 text-ui text-ink-muted">
                Select a passage in the editor and pick an action, or ask a question. Suggested edits appear as diffs; nothing changes until you accept.
              </p>
            </div>
          )
        ) : (
          messages.map((m) => (
            <MessageView
              key={m.id}
              projectId={projectId}
              message={m}
              proposals={(detail?.proposals ?? []).filter((p) => p.messageId === m.id)}
              activity={conversationId ? (activity[conversationId] ?? []) : []}
            />
          ))
        )}
      </div>

      <div className="space-y-2 border-t border-rule bg-panel px-2.5 py-2">
        <ContextChips projectId={projectId} />
        <ActionBar disabled={!!streamingMessage || sending} hasSelection={hasSelection} onRun={(id) => void send(id)} />
        <textarea
          aria-label="Message the assistant"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={hasSelection ? 'Ask about the selection… (Enter to send)' : 'Ask a question… (Enter to send)'}
          className="block w-full resize-none rounded-ctl border border-rule bg-raised px-2 py-1.5 text-ui text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TargetPicker projectId={projectId} />
          </div>
          {streamingMessage ? (
            <Button aria-label="Stop" onClick={() => void stop(projectId, streamingMessage.id)}>
              <Square /> Stop
            </Button>
          ) : (
            <Button variant="primary" aria-label="Send" disabled={!text.trim() || sending} onClick={() => void send('chat')}>
              <SendHorizontal />
            </Button>
          )}
        </div>
      </div>

      <SetupDialog projectId={projectId} />
      <ReviewDialog projectId={projectId} proposals={detail?.proposals ?? []} />
    </aside>
  );
}
