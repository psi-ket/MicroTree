import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { editor as MonacoEditor } from 'monaco-editor';
import { RuntimeApiError } from '@research-studio/api-contracts';
import type { BibChange } from '@research-studio/shared-types';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary } from '../../lib/queries';
import { useResolvedTheme } from '../../lib/theme';
import { Tag } from '../literature/common';
import { CHANGE_LABEL } from '../library/model';

/**
 * The .bib file is changed only from here: the user sees the diff of exactly
 * the changes they keep checked, and the write is refused if the file changed
 * since this preview was made.
 */
export function BibReviewDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const theme = useResolvedTheme();
  const diffRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  // null: all applicable changes (the first preview decides which those are).
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [applying, setApplying] = useState(false);
  const preview = useQuery({
    queryKey: ['references', projectId, 'bib-preview', chosen],
    queryFn: () => runtime().references.previewBib(projectId, chosen ? { changeIds: chosen } : {}),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!open) {
      setChosen(null);
      return;
    }
    return () => {
      const model = diffRef.current?.getModel();
      diffRef.current = null;
      setTimeout(() => {
        model?.original.dispose();
        model?.modified.dispose();
      }, 0);
    };
  }, [open]);

  const onMount: DiffOnMount = (diff) => {
    diffRef.current = diff;
  };

  const data = preview.data;
  const applicable = data?.changes.filter((c) => c.applicable) ?? [];
  const selected = new Set(chosen ?? applicable.map((c) => c.id));
  const toggle = (c: BibChange, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(c.id);
    else next.delete(c.id);
    setChosen(applicable.filter((x) => next.has(x.id)).map((x) => x.id));
  };
  // The diff on screen must be the one for the current selection before it can be applied.
  const upToDate = !!data && !preview.isFetching && !preview.isPlaceholderData;

  const apply = async () => {
    if (!data) return;
    setApplying(true);
    try {
      const { applied, path } = await runtime().references.applyBib(projectId, { path: data.path, baseHash: data.baseHash, changeIds: [...selected] });
      toast.success(`${path} updated`, { description: `${applied.length} change${applied.length === 1 ? '' : 's'} written` });
      invalidateLibrary();
      onClose();
    } catch (err) {
      if (err instanceof RuntimeApiError && (err.details as { reason?: string } | undefined)?.reason === 'STALE_PREVIEW') {
        toast.warning('The file changed while you were reviewing', { description: 'The preview now shows the changes against the current file. Review them again.' });
        void preview.refetch();
      } else {
        toast.error('Could not update the bibliography', { description: errorMessage(err) });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="top-[4vh] flex h-[90vh] w-[min(1240px,calc(100vw-32px))] flex-col" aria-describedby="bib-review-desc" data-testid="bib-review">
        <DialogTitle className="pr-8">
          Update <span className="font-mono text-[15px]">{data?.path ?? 'the bibliography'}</span>
        </DialogTitle>
        <DialogDescription id="bib-review-desc">
          Left: the file now{data && data.baseHash === null ? ' (it does not exist yet)' : ''}. Right: the file with the checked changes. Existing entries and fields are never removed or renamed.
        </DialogDescription>
        {preview.isLoading ? (
          <div className="grid flex-1 place-items-center">
            <Spinner />
          </div>
        ) : preview.error && !data ? (
          <p className="mt-4 text-ui text-danger">{errorMessage(preview.error)}</p>
        ) : data ? (
          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <section aria-label="Changes" className="flex max-h-56 flex-col md:max-h-none md:w-[320px] md:shrink-0">
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 text-xs">
                {data.changes.map((c) => (
                  <li key={c.id} className={cn('rounded border border-rule p-2', !c.applicable && 'bg-sunken/50')}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={c.applicable && selected.has(c.id)}
                        disabled={!c.applicable}
                        onChange={(e) => toggle(c, e.target.checked)}
                        className="mt-0.5 accent-[var(--rs-accent)]"
                        aria-label={`${CHANGE_LABEL[c.kind]}: ${c.citationKey ?? 'no key'}`}
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono text-ink">{c.citationKey ?? '—'}</code>
                          <Tag dot={c.applicable ? 'success' : c.kind === 'unchanged' ? 'neutral' : 'warning'}>{CHANGE_LABEL[c.kind]}</Tag>
                        </span>
                        <span className="mt-0.5 block text-ink-muted">{c.message}</span>
                      </span>
                    </label>
                  </li>
                ))}
                {!data.changes.length ? <li className="text-ui text-ink-muted">No papers are attached to this project yet.</li> : null}
              </ul>
              {data.warnings.length ? (
                <p className="mt-2 text-2xs text-warning">
                  {data.warnings.length} part{data.warnings.length === 1 ? '' : 's'} of the file could not be read and stay as they are: {data.warnings.slice(0, 2).join('; ')}
                </p>
              ) : null}
            </section>
            <div className="min-h-[240px] flex-1 overflow-hidden rounded-md border border-rule">
              <DiffEditor
                original={data.original}
                modified={data.proposed}
                language="bibtex"
                theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
                onMount={onMount}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: true,
                  wordWrap: 'on',
                  diffWordWrap: 'on',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  fontFamily: "'Atkinson Hyperlegible Mono Variable', ui-monospace, monospace",
                  fontSize: 13,
                }}
              />
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          {preview.isFetching && data ? <Spinner className="mr-auto text-ink-muted" /> : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!upToDate || !selected.size || applying} onClick={() => void apply()} data-testid="bib-apply">
            {applying ? <Spinner /> : null}
            Write {selected.size} change{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
