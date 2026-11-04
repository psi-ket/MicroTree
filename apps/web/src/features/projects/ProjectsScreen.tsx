import { BookMarked, FolderOpen, Library,MoreHorizontal, Plus, Settings2, Shapes, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LATEX_ENGINES, PROJECT_TEMPLATES, type LatexEngine, type Project, type ProjectTemplate } from '@research-studio/shared-types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  Spinner,
} from '@research-studio/ui';
import { useQueryClient } from '@tanstack/react-query';
import { runtime } from '../../lib/connection';
import { errorMessage, keys, useProjects, useRuntimeInfo } from '../../lib/queries';
import { openLibrary, openLiterature, openVisual } from '../../lib/routes';
import { useLayout } from '../../stores/layout';
import { SettingsDialog } from '../settings/SettingsDialog';

const TEMPLATE_LABEL: Record<ProjectTemplate, string> = {
  article: 'Article',
  report: 'Report with chapters',
  beamer: 'Beamer slides',
  empty: 'Empty document',
};

const ENGINE_LABEL: Record<LatexEngine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('article');
  const [engine, setEngine] = useState<LatexEngine>('pdflatex');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the project a name.');
    setBusy(true);
    setError(null);
    try {
      const { project } = await runtime().createProject({ name, template, engine, ...(author.trim() ? { author } : {}) });
      onCreated(project);
      setName('');
      setAuthor('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(460px,calc(100vw-32px))]">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>Creates a folder in your workspace with a starter document.</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Thermal transport in layered oxides" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-author">Author (optional)</Label>
            <Input id="project-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-template">Template</Label>
              <Select id="project-template" value={template} onChange={(e) => setTemplate(e.target.value as ProjectTemplate)}>
                {PROJECT_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {TEMPLATE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-engine">Engine</Label>
              <Select id="project-engine" value={engine} onChange={(e) => setEngine(e.target.value as LatexEngine)}>
                {LATEX_ENGINES.map((en) => (
                  <option key={en} value={en}>
                    {ENGINE_LABEL[en]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-ui text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const run = async () => {
    if (!project) return;
    try {
      await runtime().deleteProject(project.id, deleteFiles);
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(deleteFiles ? `Deleted ${project.name} and its files` : `Removed ${project.name} from the list`);
      onClose();
    } catch (err) {
      toast.error('Could not delete the project', { description: errorMessage(err) });
    }
  };
  return (
    <Dialog open={project !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Remove {project?.name}?</DialogTitle>
        <DialogDescription>By default the folder stays on disk and only leaves Research Studio.</DialogDescription>
        <label className="mt-4 flex items-start gap-2 text-ui text-ink">
          <input type="checkbox" className="mt-0.5 accent-danger" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          <span>
            Also delete the folder <code className="break-all font-mono text-2xs text-ink-muted">{project?.rootPath}</code>
          </span>
        </label>
        <DialogFooter>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" onClick={() => void run()}>
            {deleteFiles ? 'Delete project and files' : 'Remove project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: projects, isLoading, error } = useProjects();
  const { data: info } = useRuntimeInfo();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const sorted = [...(projects ?? [])].sort((a, b) =>
    (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt),
  );

  return (
    <main className="min-h-dvh bg-paper">
      <header className="flex h-12 items-center border-b border-rule px-5">
        <span className="font-display text-[17px] text-ink">Research Studio</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => openLiterature()} data-testid="open-literature">
          <Library /> Literature
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openLibrary()} data-testid="open-library">
          <BookMarked /> Library
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openVisual()} data-testid="open-visual">
          <Shapes /> Visual Studio
        </Button>
        <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 />
        </Button>
      </header>
      <div className="mx-auto max-w-4xl px-5 py-10">
        <div className="flex flex-wrap items-end gap-4">
          <div className="mr-auto">
            <h1 className="font-display text-[30px] leading-tight text-ink">Projects</h1>
            <p className="mt-1 break-all font-mono text-2xs text-ink-faint">{info?.workspaceRoot}</p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-project">
            <Plus /> New project
          </Button>
        </div>

        {info && !info.toolchain.latexmk.available ? (
          <p role="alert" className="mt-6 rounded-ctl border border-warning/40 bg-warning-soft px-3 py-2 text-ui text-warning">
            latexmk was not found on the runtime machine, so projects cannot be compiled. Install TeX Live or MiKTeX, or set
            RS_LATEXMK_PATH, then restart the runtime.
          </p>
        ) : null}

        <div className="mt-6 overflow-hidden rounded-lg border border-rule bg-panel">
          {isLoading ? (
            <div className="p-6">
              <Spinner className="text-ink-faint" />
            </div>
          ) : error ? (
            <p className="p-6 text-ui text-danger">{errorMessage(error)}</p>
          ) : sorted.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="font-display text-[20px] italic text-ink-muted">No projects yet</p>
              <p className="mt-1.5 text-ui text-ink-faint">Start one from a template; it becomes a normal folder you can also open elsewhere.</p>
              <Button className="mt-5" variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New project
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {sorted.map((p) => (
                <li key={p.id} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-sunken/60"
                    data-testid={`project-${p.slug}`}
                  >
                    <FolderOpen className="size-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{p.name}</span>
                      <span className="block truncate font-mono text-2xs text-ink-faint">
                        {p.mainFile} · {ENGINE_LABEL[p.engine]}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs text-ink-faint sm:block">
                      {dateFormat.format(new Date(p.lastOpenedAt ?? p.updatedAt))}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="mr-3" aria-label={`Actions for ${p.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem danger onSelect={() => setDeleting(p)}>
                        <Trash2 /> Remove project…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(p) => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: keys.projects });
          onOpen(p.id);
        }}
      />
      <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />
      <SettingsDialog />
    </main>
  );
}
