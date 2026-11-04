import { useQuery } from '@tanstack/react-query';
import { FilePlus2, FilePen, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RuntimeApiError, type InsertionPlan, type VisualArtifact } from '@research-studio/api-contracts';
import type { FileTreeNode } from '@research-studio/shared-types';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FieldHint, Input, Label, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { queryClient, useProjects } from '../../lib/queries';
import { errorText } from './model';
import { useInsertions, visualKeys } from './queries';
import { SafeDiff } from './SafeDiff';

function texFiles(node: FileTreeNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === 'file' && /\.tex$/i.test(node.path)) out.push(node.path);
  for (const c of node.children ?? []) texFiles(c, out);
  return out;
}

/**
 * Insert an approved version into a project, after review: every file that
 * will be created and every change to an existing file is shown first.
 * Preamble changes are only made when ticked. Applying writes exactly what
 * was reviewed (the runtime refuses if anything changed in between), and an
 * insertion can be rolled back.
 */
export function InsertDialog({ open, onClose, artifact, versionNumber, defaultProjectId }: { open: boolean; onClose: () => void; artifact: VisualArtifact; versionNumber: number; defaultProjectId: string | null }) {
  const projects = useProjects();
  const [projectId, setProjectId] = useState(defaultProjectId ?? artifact.projectId ?? '');
  const project = projects.data?.find((p) => p.id === projectId);
  const tree = useQuery({ queryKey: ['tree', projectId], queryFn: () => runtime().tree(projectId), enabled: open && !!projectId });
  const files = texFiles(tree.data?.tree);
  const [target, setTarget] = useState<string>('');
  const [caption, setCaption] = useState('');
  const [label, setLabel] = useState('');
  const [addPreamble, setAddPreamble] = useState(false);
  const [plan, setPlan] = useState<InsertionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insertions = useInsertions(open && projectId ? projectId : null);
  const targetFile = target || project?.mainFile || null;

  const options = () => ({ projectId, version: versionNumber, targetFile, caption: caption || null, label: label || null, addPreamble, directory: 'figures' });

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan((await runtime().visual.previewInsertion(artifact.id, options())).plan);
    } catch (e) {
      setError(errorText(e));
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await runtime().visual.insert(artifact.id, { ...options(), planHash: plan.planHash });
      toast.success('Inserted. You can undo it from this dialog.');
      void queryClient.invalidateQueries({ queryKey: visualKeys.insertions(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['tree', projectId] });
      setPlan(null);
    } catch (e) {
      if (e instanceof RuntimeApiError && (e.details as { reason?: string } | undefined)?.reason === 'STALE_PREVIEW') {
        setError('The project changed since you reviewed this. Review the changes again.');
        setPlan(null);
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (id: string) => {
    try {
      const r = await runtime().visual.rollback(id);
      toast.success(`Undone: ${[...r.restored.map((p) => `restored ${p}`), ...r.removed.map((p) => `removed ${p}`)].join(', ')}`);
      void queryClient.invalidateQueries({ queryKey: visualKeys.insertions(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['tree', projectId] });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[4vh] flex max-h-[92vh] w-[min(1100px,calc(100vw-24px))] flex-col overflow-hidden" aria-describedby="insert-desc" data-testid="insert-dialog">
        <DialogTitle>Insert into a project</DialogTitle>
        <DialogDescription id="insert-desc">Version {versionNumber} of “{artifact.title}”. Nothing is written until you apply the reviewed changes.</DialogDescription>
        <div className="mt-3 grid min-h-0 gap-3 overflow-auto md:grid-cols-[280px_1fr]">
          <div className="flex flex-col gap-2">
            <div>
              <Label htmlFor="ins-project">Project</Label>
              <Select id="ins-project" value={projectId} onChange={(e) => (setProjectId(e.target.value), setPlan(null), setTarget(''))}>
                <option value="">Choose…</option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ins-target">Insert into</Label>
              <Select id="ins-target" value={target} onChange={(e) => (setTarget(e.target.value), setPlan(null))} data-testid="insert-target">
                <option value="">{project ? `${project.mainFile} (before \\end{document})` : 'Main file'}</option>
                {files
                  .filter((f) => f !== project?.mainFile)
                  .map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
              </Select>
            </div>
            {artifact.artifactType !== 'equation' && artifact.artifactType !== 'explanation' ? (
              <div>
                <Label htmlFor="ins-caption">Caption</Label>
                <Input id="ins-caption" value={caption} onChange={(e) => (setCaption(e.target.value), setPlan(null))} maxLength={2000} />
              </div>
            ) : null}
            <div>
              <Label htmlFor="ins-label">Label</Label>
              <Input id="ins-label" value={label} placeholder={artifact.artifactType === 'equation' ? 'eq:hamiltonian' : 'fig:setup'} onChange={(e) => (setLabel(e.target.value), setPlan(null))} maxLength={60} />
            </div>
            <label className="flex items-start gap-2 text-ui">
              <input type="checkbox" className="mt-1" checked={addPreamble} onChange={(e) => (setAddPreamble(e.target.checked), setPlan(null))} data-testid="add-preamble" />
              <span>Add missing packages to the preamble of the main file</span>
            </label>
            <Button disabled={!projectId || busy} onClick={() => void review()} data-testid="review-insertion">
              {busy && !plan ? <Spinner /> : null} Review changes
            </Button>
            {error ? (
              <p className="text-ui text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {insertions.data?.length ? (
              <section className="mt-2">
                <h3 className="mb-1 text-[12px] font-medium text-ink-muted">Earlier insertions</h3>
                <ul className="flex flex-col gap-1 text-[12px]">
                  {insertions.data.map((i) => (
                    <li key={i.id} className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate">{[...i.createdFiles, ...i.modifiedFiles].map((f) => f.path).join(', ')}</span>
                      {i.status === 'applied' ? (
                        <Button size="sm" variant="ghost" onClick={() => void rollback(i.id)} data-testid="rollback">
                          <Undo2 /> Undo
                        </Button>
                      ) : (
                        <Badge>undone</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
          <div className="flex min-h-[320px] flex-col gap-2" data-testid="insertion-plan">
            {!plan ? (
              <p className="text-ui text-ink-muted">Choose where to insert it and review the changes.</p>
            ) : (
              <>
                {plan.warnings.map((w, i) => (
                  <p key={i} className="rounded-ctl bg-warning-soft/50 px-2 py-1 text-ui">
                    {w}
                  </p>
                ))}
                {plan.missingPackages.length && !addPreamble ? <FieldHint className="text-ink-muted">Tick “Add missing packages” to see the preamble change ({plan.preambleLines.join(' ')}).</FieldHint> : null}
                {plan.createdFiles.map((f) => (
                  <details key={f.path} className="rounded-md border border-rule" open={plan.createdFiles.length === 1}>
                    <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-ui">
                      <FilePlus2 className="size-4 text-success" aria-hidden /> New file <span className="font-mono text-[12px]">{f.path}</span>
                    </summary>
                    <pre className="max-h-48 overflow-auto border-t border-rule p-2 font-mono text-[11px]">{f.content}</pre>
                  </details>
                ))}
                {plan.modifiedFiles.map((m) => (
                  <div key={m.path} className="flex min-h-[260px] flex-1 flex-col rounded-md border border-rule">
                    <div className="flex items-center gap-2 border-b border-rule px-2 py-1 text-ui">
                      <FilePen className="size-4 text-warning" aria-hidden /> Changes to <span className="font-mono text-[12px]">{m.path}</span>
                    </div>
                    <div className="min-h-0 flex-1">
                      <SafeDiff original={m.before} modified={m.after} path={`visual-ins://${plan.planHash}/${m.path}`} sideBySide={false} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!plan || busy} onClick={() => void apply()} data-testid="apply-insertion">
            {busy && plan ? <Spinner /> : null} Apply these changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
