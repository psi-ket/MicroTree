import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { editorLanguageFor } from '@research-studio/document-engine';
import type { EditProposal } from '@research-studio/shared-types';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { useResolvedTheme } from '../../lib/theme';
import { acceptProposal, rejectProposal, revertProposal } from './actions';
import { aiKeys, useAssistant } from './state';

const CHANGE_LABEL = { modify: 'Edit', create: 'New file', delete: 'Delete file' } as const;

/** Side-by-side review of one proposal. The right side can be edited before accepting. */
export function ReviewDialog({ projectId, proposals }: { projectId: string; proposals: EditProposal[] }) {
  const { reviewing, review } = useAssistant();
  const proposal = proposals.find((p) => p.id === reviewing) ?? null;
  const theme = useResolvedTheme();
  const diffRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: aiKeys.preview(projectId, reviewing ?? ''),
    queryFn: () => runtime().ai.previewProposal(projectId, reviewing!),
    enabled: !!reviewing,
    staleTime: 0,
  });
  const close = () => {
    review(null);
    setEdited(false);
  };

  // The wrapper disposes models before the diff widget lets go of them, which
  // Monaco reports as an error. Keep them alive and dispose them afterwards.
  useEffect(() => {
    if (!reviewing) return;
    return () => {
      const model = diffRef.current?.getModel();
      diffRef.current = null;
      setTimeout(() => {
        model?.original.dispose();
        model?.modified.dispose();
      }, 0);
    };
  }, [reviewing]);

  const onMount: DiffOnMount = (diff) => {
    diffRef.current = diff;
    // Long LaTeX paragraphs need wrapping on both sides.
    diff.getOriginalEditor().updateOptions({ wordWrap: 'on' });
    const modified = diff.getModifiedEditor();
    modified.onDidChangeModelContent(() => setEdited(modified.getValue() !== (preview.data?.after ?? '')));
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    run(async () => {
      if (!proposal) return;
      const content = edited ? diffRef.current?.getModifiedEditor().getValue() : undefined;
      if (await acceptProposal(projectId, proposal, content)) close();
    });

  const data = preview.data;
  const pending = proposal?.status === 'pending' && data && !data.stale;
  const editable = pending && proposal.changeType !== 'delete';

  return (
    <Dialog open={!!proposal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="top-[5vh] flex h-[88vh] w-[min(1200px,calc(100vw-32px))] flex-col" aria-describedby="review-desc" data-testid="review-dialog">
        <DialogTitle className="pr-8">
          {proposal ? (
            <>
              <span className="font-mono text-[15px]">{proposal.file}</span> <Badge tone="accent">{CHANGE_LABEL[proposal.changeType]}</Badge>{' '}
              {proposal.status !== 'pending' ? <Badge tone={proposal.status === 'accepted' ? 'success' : 'neutral'}>{proposal.status}</Badge> : null}
            </>
          ) : null}
        </DialogTitle>
        <DialogDescription id="review-desc">{proposal?.explanation || 'Review the change before it reaches your file.'}</DialogDescription>
        {proposal?.warnings.length ? (
          <ul className="mt-2 space-y-0.5 rounded border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-ink">
            {proposal.warnings.map((w) => (
              <li key={w.code + w.message}>⚠ {w.message}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-rule">
          {preview.isLoading ? (
            <div className="flex h-full items-center justify-center"><Spinner /></div>
          ) : preview.error ? (
            <p className="p-4 text-ui text-danger">{errorMessage(preview.error)}</p>
          ) : data?.stale ? (
            <p className="p-4 text-ui text-ink">
              {proposal?.file} has changed since this edit was proposed, so it can no longer be applied safely. Dismiss it and ask again.
            </p>
          ) : data && proposal ? (
            <DiffEditor
              original={data.before ?? ''}
              modified={data.after ?? proposal.proposed}
              language={editorLanguageFor(proposal.file)}
              theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
              onMount={onMount}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              options={{
                readOnly: !editable,
                originalEditable: false,
                renderSideBySide: true,
                wordWrap: 'on',
                diffWordWrap: 'on',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
                fontFamily: "'Atkinson Hyperlegible Mono Variable', ui-monospace, monospace",
                fontSize: 13,
              }}
            />
          ) : null}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="mr-auto text-xs text-ink-muted">
            {editable ? (edited ? 'You edited the proposal; your version will be applied.' : 'You can edit the right side before accepting.') : null}
          </span>
          {proposal && (proposal.status === 'pending' || proposal.status === 'stale') ? (
            <Button disabled={busy} onClick={() => void run(async () => { await rejectProposal(projectId, proposal); close(); })}>
              {proposal.status === 'stale' ? 'Dismiss' : 'Reject'}
            </Button>
          ) : null}
          {proposal?.status === 'accepted' ? (
            <Button disabled={busy} onClick={() => void run(async () => { await revertProposal(projectId, proposal); close(); })}>
              Revert
            </Button>
          ) : null}
          {pending ? (
            <Button variant="primary" disabled={busy} onClick={() => void accept()} data-testid="review-accept">
              {edited ? 'Accept my version' : 'Accept'}
            </Button>
          ) : (
            <Button variant="primary" onClick={close}>
              Close
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
