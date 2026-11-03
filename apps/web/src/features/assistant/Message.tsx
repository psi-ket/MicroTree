import { segmentMessage } from '@research-studio/ai-core';
import type { AgentActivity, ConversationMessage, EditProposal } from '@research-studio/shared-types';
import { Badge, Button, cn, Spinner } from '@research-studio/ui';
import { Fragment, type ReactNode } from 'react';
import { acceptProposal, rejectProposal, revertProposal } from './actions';
import { useAssistant } from './state';

// ------------------------------------------------------------- light markdown

function inline(text: string): ReactNode[] {
  // `code` and **bold**; everything else is plain text (React escapes it).
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="rounded-[3px] bg-sunken px-1 font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Prose({ text }: { text: string }) {
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <>
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded border border-rule bg-sunken px-2 py-1.5 font-mono text-2xs leading-[1.1rem] text-ink">
            {block.replace(/\n$/, '')}
          </pre>
        ) : (
          block
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((para, j) => {
              const lines = para.split('\n');
              if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
                return (
                  <ul key={`${i}-${j}`} className="my-1 list-disc space-y-0.5 pl-4">
                    {lines.map((l, k) => (
                      <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>
                    ))}
                  </ul>
                );
              }
              return (
                <p key={`${i}-${j}`} className="my-1 whitespace-pre-wrap">
                  {inline(para)}
                </p>
              );
            })
        ),
      )}
    </>
  );
}

// ----------------------------------------------------------------- proposals

const STATUS_TONE = { pending: 'accent', accepted: 'success', rejected: 'neutral', stale: 'warning', reverted: 'neutral' } as const;
const STATUS_LABEL = { pending: 'Proposed', accepted: 'Applied', rejected: 'Rejected', stale: 'Out of date', reverted: 'Reverted' } as const;

export function ProposalCard({ projectId, proposal }: { projectId: string; proposal: EditProposal }) {
  const review = useAssistant((s) => s.review);
  const small = proposal.changeType === 'modify' && proposal.original.length + proposal.proposed.length < 900;
  return (
    <div className="mt-2 rounded-md border border-rule bg-panel" data-testid="proposal-card" data-status={proposal.status}>
      <div className="flex items-center gap-1.5 border-b border-rule px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink" title={proposal.file}>
          {proposal.changeType === 'create' ? '+ ' : proposal.changeType === 'delete' ? '− ' : ''}
          {proposal.file}
        </span>
        {proposal.warnings.length ? <Badge tone="warning" title={proposal.warnings.map((w) => w.message).join('\n')}>⚠ {proposal.warnings.length}</Badge> : null}
        <Badge tone={STATUS_TONE[proposal.status]}>{STATUS_LABEL[proposal.status]}</Badge>
      </div>
      {small ? (
        <div className="space-y-1 px-2 py-1.5 font-mono text-2xs leading-[1.1rem]">
          <div className="whitespace-pre-wrap break-words rounded-[3px] bg-danger-soft px-1.5 py-0.5 text-ink line-through decoration-danger/50">{proposal.original}</div>
          <div className="whitespace-pre-wrap break-words rounded-[3px] bg-success-soft px-1.5 py-0.5 text-ink">{proposal.proposed}</div>
        </div>
      ) : (
        <p className="px-2 py-1.5 text-xs text-ink-muted">
          {proposal.changeType === 'create'
            ? `New file, ${proposal.proposed.split('\n').length} lines`
            : proposal.changeType === 'delete'
              ? 'Deletes this file'
              : 'Larger change — open the review to see it in context.'}
        </p>
      )}
      {proposal.explanation ? <p className="px-2 pb-1.5 text-xs italic text-ink-muted">{proposal.explanation}</p> : null}
      <div className="flex flex-wrap gap-1.5 border-t border-rule px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={() => review(proposal.id)}>
          Review diff
        </Button>
        <span className="flex-1" />
        {proposal.status === 'pending' ? (
          <>
            <Button size="sm" onClick={() => void rejectProposal(projectId, proposal)}>
              Reject
            </Button>
            <Button size="sm" variant="primary" onClick={() => void acceptProposal(projectId, proposal)} data-testid="proposal-accept">
              Accept
            </Button>
          </>
        ) : null}
        {proposal.status === 'stale' ? (
          <Button size="sm" onClick={() => void rejectProposal(projectId, proposal)}>
            Dismiss
          </Button>
        ) : null}
        {proposal.status === 'accepted' ? (
          <Button size="sm" onClick={() => void revertProposal(projectId, proposal)}>
            Revert
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ messages

function usageLine(m: ConversationMessage): string | null {
  const u = m.usage;
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens !== null) parts.push(`${u.inputTokens.toLocaleString()} in`);
  if (u.outputTokens !== null) parts.push(`${u.outputTokens.toLocaleString()} out`);
  if (u.costUsd !== null) parts.push(`$${u.costUsd.toFixed(4)}`);
  return parts.length ? parts.join(' · ') : null;
}

export function MessageView({
  projectId,
  message,
  proposals,
  activity,
}: {
  projectId: string;
  message: ConversationMessage;
  proposals: EditProposal[];
  activity: AgentActivity[];
}) {
  const live = useAssistant((s) => s.streaming[message.id]);
  if (message.role === 'user') {
    return (
      <div className="ml-6 mt-3 rounded-md bg-accent-soft px-2.5 py-1.5 text-ui text-ink" data-testid="user-message">
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    );
  }
  const streaming = message.status === 'streaming';
  const content = streaming ? (live ?? message.content) : message.content;
  const segments = segmentMessage(content);
  const drafting = streaming && segments.some((s) => s.type === 'pending-edit' || s.type === 'edit');
  // An answer that did not finish normally offers no proposals; its edit text stays readable here.
  const unfinishedEdits = !streaming && message.status !== 'complete' && segments.some((s) => s.type !== 'text');
  const text = segments.flatMap((s) => (s.type === 'text' ? [s.text] : [])).join('').trim();
  const usage = usageLine(message);

  return (
    <div className="mt-3" data-testid="assistant-message" data-status={message.status}>
      <div className={cn('text-ui leading-[1.35rem] text-ink', !text && streaming && 'text-ink-faint')}>
        {text ? <Prose text={text} /> : streaming ? <p className="italic">Thinking…</p> : null}
      </div>
      {streaming && activity.length ? (
        <ul className="mt-1 space-y-0.5 border-l-2 border-rule pl-2 font-mono text-2xs text-ink-faint">
          {activity.slice(-4).map((a, i) => (
            <li key={i} className="truncate">
              {a.label}
              {a.detail ? ` ${a.detail}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {drafting ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
          <Spinner className="size-3" /> Drafting an edit…
        </p>
      ) : null}
      {proposals.map((p) => (
        <ProposalCard key={p.id} projectId={projectId} proposal={p} />
      ))}
      {message.editIssues.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-warning">
          {message.editIssues.map((issue, i) => (
            <li key={i}>Not offered for review: {issue.problem}</li>
          ))}
        </ul>
      ) : null}
      {unfinishedEdits ? (
        <details className="mt-1.5 text-xs text-ink-muted" data-testid="unfinished-edits">
          <summary className="cursor-pointer">Show the unfinished answer</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-rule bg-sunken px-2 py-1.5 font-mono text-2xs text-ink">{content}</pre>
        </details>
      ) : null}
      {message.error ? <p className={cn('mt-1.5 text-xs', message.status === 'error' ? 'text-danger' : 'text-warning')}>{message.error}</p> : null}
      {message.status === 'cancelled' ? <p className="mt-1 text-xs text-ink-faint">Stopped.</p> : null}
      {usage ? <p className="mt-1 font-mono text-[10.5px] text-ink-faint">{usage}</p> : null}
    </div>
  );
}
