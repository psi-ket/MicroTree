import {
  BookMarked,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  ImageUp,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { extractOutline, isEditablePath, UPLOAD_EXTENSIONS } from '@research-studio/document-engine';
import type { FileTreeNode, Project } from '@research-studio/shared-types';
import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  PanelHeading,
  Spinner,
  Tooltip,
} from '@research-studio/ui';
import { useTree, useUpdateProject } from '../../lib/queries';
import { useEditor } from '../../stores/editor';
import { createEntry, deleteEntry, openFile, renameEntry, uploadFiles } from '../workspace/actions';
import { ImagePreview } from './ImagePreview';

type Draft = { kind: 'file' | 'directory'; parent: string } | { kind: 'rename'; path: string; name: string };

function NodeIcon({ node, open }: { node: FileTreeNode; open: boolean }) {
  if (node.type === 'directory') {
    const Icon = open ? FolderOpen : Folder;
    return <Icon className="size-3.5 shrink-0 text-ink-faint" />;
  }
  switch (node.kind) {
    case 'tex':
      return <FileCode2 className="size-3.5 shrink-0 text-accent" />;
    case 'bib':
      return <BookMarked className="size-3.5 shrink-0 text-warning" />;
    case 'image':
    case 'pdf':
      return <ImageIcon className="size-3.5 shrink-0 text-success" />;
    default:
      return <FileText className="size-3.5 shrink-0 text-ink-faint" />;
  }
}

function NameInput({
  initial,
  depth,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  depth: number;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submit && value.trim()) onSubmit(value.trim());
    else onCancel();
  };
  return (
    <div className="flex h-6 items-center pr-2" style={{ paddingLeft: 8 + depth * 12 + 18 }}>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => {
          const dot = e.target.value.lastIndexOf('.');
          e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        }}
        onBlur={() => finish(true)}
        className="h-[22px] w-full rounded-[3px] border border-accent bg-raised px-1.5 text-ui text-ink outline-none"
      />
    </div>
  );
}

function TreeLevel({
  nodes,
  depth,
  dir,
  ctx,
}: {
  nodes: FileTreeNode[];
  depth: number;
  /** Directory these nodes live in ('' for the project root). */
  dir: string;
  ctx: TreeContext;
}) {
  return (
    <>
      {ctx.draft && ctx.draft.kind !== 'rename' && ctx.draft.parent === dir ? (
        <NameInput
          initial=""
          depth={depth}
          placeholder={ctx.draft.kind === 'file' ? 'New file name, e.g. methods.tex' : 'New folder name'}
          onSubmit={(name) => ctx.submitDraft(name)}
          onCancel={() => ctx.setDraft(null)}
        />
      ) : null}
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} ctx={ctx} />
      ))}
    </>
  );
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

interface TreeContext {
  project: Project;
  active: string | null;
  expanded: Set<string>;
  toggle(path: string): void;
  expand(path: string): void;
  draft: Draft | null;
  setDraft(d: Draft | null): void;
  submitDraft(name: string): void;
  select(node: FileTreeNode): void;
  askDelete(path: string): void;
  dropTarget: string | null;
  setDropTarget(path: string | null): void;
  onDropFiles(e: DragEvent, dir: string): void;
}

function TreeRow({ node, depth, ctx }: { node: FileTreeNode; depth: number; ctx: TreeContext }) {
  const updateProject = useUpdateProject(ctx.project.id);
  const isDir = node.type === 'directory';
  const open = isDir && ctx.expanded.has(node.path);
  const isMain = node.path === ctx.project.mainFile;
  const draft = ctx.draft;

  if (draft?.kind === 'rename' && draft.path === node.path) {
    return (
      <NameInput
        initial={draft.name}
        depth={depth}
        placeholder="New name"
        onSubmit={(name) => ctx.submitDraft(name)}
        onCancel={() => ctx.setDraft(null)}
      />
    );
  }

  const dir = isDir ? node.path : parentOf(node.path);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-testid={`tree-${node.path}`}
            onClick={() => ctx.select(node)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              ctx.setDropTarget(dir);
            }}
            onDrop={(e) => ctx.onDropFiles(e, dir)}
            className={cn(
              'group flex h-6 w-full items-center gap-1.5 pr-2 text-left text-ui',
              ctx.active === node.path ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-sunken hover:text-ink',
              ctx.dropTarget === node.path && isDir && 'outline outline-1 -outline-offset-1 outline-accent',
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            aria-expanded={isDir ? open : undefined}
          >
            {isDir ? (
              <ChevronRight className={cn('size-3 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <NodeIcon node={node} open={open} />
            <span className="truncate">{node.name}</span>
            {isMain ? (
              <span className="ml-auto rounded-[3px] bg-accent-soft px-1 text-[10px] font-semibold uppercase tracking-wider text-accent">
                main
              </span>
            ) : null}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isDir ? (
            <>
              <ContextMenuItem onSelect={() => { ctx.expand(node.path); ctx.setDraft({ kind: 'file', parent: node.path }); }}>
                <FilePlus2 /> New file here
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => { ctx.expand(node.path); ctx.setDraft({ kind: 'directory', parent: node.path }); }}>
                <FolderPlus /> New folder here
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          {!isDir && node.kind === 'tex' && !isMain ? (
            <ContextMenuItem onSelect={() => updateProject.mutate({ mainFile: node.path })}>
              <Star /> Set as main file
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => ctx.setDraft({ kind: 'rename', path: node.path, name: node.name })}>
            <Pencil /> Rename
          </ContextMenuItem>
          <ContextMenuItem danger onSelect={() => ctx.askDelete(node.path)}>
            <Trash2 /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && node.children ? <TreeLevel nodes={node.children} depth={depth + 1} dir={node.path} ctx={ctx} /> : null}
    </>
  );
}

function Outline() {
  const { active, buffers, revealAt } = useEditor();
  const buffer = active ? buffers[active] : undefined;
  const outline = useMemo(() => (buffer?.kind === 'tex' ? extractOutline(buffer.content) : []), [buffer?.content, buffer?.kind]);
  if (!buffer || buffer.kind !== 'tex') return null;
  return (
    <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-rule">
      <PanelHeading>Outline</PanelHeading>
      <div className="min-h-0 overflow-auto pb-2">
        {outline.length === 0 ? (
          <p className="px-3 text-xs text-ink-faint">No sections in this file.</p>
        ) : (
          outline.map((entry, i) => {
            const minLevel = Math.min(...outline.map((o) => o.level));
            return (
              <button
                key={i}
                type="button"
                onClick={() => revealAt(buffer.path, entry.line)}
                className="block w-full truncate py-0.5 pr-2 text-left text-ui text-ink-muted hover:bg-sunken hover:text-ink"
                style={{ paddingLeft: 12 + (entry.level - minLevel) * 12 }}
                title={`Line ${entry.line}`}
              >
                {entry.title || <span className="italic text-ink-faint">untitled {entry.kind}</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function Explorer({ project }: { project: Project }) {
  const { data: tree, isLoading } = useTree(project.id);
  const active = useEditor((s) => s.active);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef('figures');

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const submitDraft = (name: string) => {
    const d = draft;
    setDraft(null);
    if (!d) return;
    if (d.kind === 'rename') {
      const to = parentOf(d.path) ? `${parentOf(d.path)}/${name}` : name;
      if (to !== d.path) void renameEntry(d.path, to);
      return;
    }
    const path = d.parent ? `${d.parent}/${name}` : name;
    if (d.kind === 'file' && !isEditablePath(path)) {
      void createEntry(`${path}.tex`, 'file');
      return;
    }
    if (d.parent) setExpanded((prev) => new Set(prev).add(d.parent));
    void createEntry(path, d.kind);
  };

  const onDropFiles = (e: DragEvent, dir: string) => {
    e.preventDefault();
    setDropTarget(null);
    const files = [...e.dataTransfer.files];
    if (files.length) void uploadFiles(files, dir || 'figures');
  };

  const ctx: TreeContext = {
    project,
    active,
    expanded,
    toggle,
    expand: (path) => setExpanded((prev) => new Set(prev).add(path)),
    draft,
    setDraft,
    submitDraft,
    select: (node) => {
      if (node.type === 'directory') return toggle(node.path);
      if (node.kind === 'image' || node.kind === 'pdf') return setPreview(node.path);
      void openFile(node.path);
    },
    askDelete: setPendingDelete,
    dropTarget,
    setDropTarget,
    onDropFiles,
  };

  const startUpload = (dir: string) => {
    uploadDir.current = dir;
    uploadInput.current?.click();
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper" aria-label="Project explorer">
      <PanelHeading className="pr-1.5">
        <span className="mr-auto">Files</span>
        <Tooltip content="New file">
          <Button variant="ghost" size="icon-sm" aria-label="New file" onClick={() => setDraft({ kind: 'file', parent: '' })}>
            <FilePlus2 />
          </Button>
        </Tooltip>
        <Tooltip content="New folder">
          <Button variant="ghost" size="icon-sm" aria-label="New folder" onClick={() => setDraft({ kind: 'directory', parent: '' })}>
            <FolderPlus />
          </Button>
        </Tooltip>
        <Tooltip content="Upload images into figures/">
          <Button variant="ghost" size="icon-sm" aria-label="Upload image" onClick={() => startUpload('figures')}>
            <ImageUp />
          </Button>
        </Tooltip>
      </PanelHeading>
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        accept={UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) {
            setExpanded((prev) => new Set(prev).add(uploadDir.current));
            void uploadFiles(files, uploadDir.current);
          }
        }}
      />
      <div
        className={cn('min-h-0 flex-1 overflow-auto pb-4', dropTarget === '' && 'bg-accent-soft/40')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          if (e.target === e.currentTarget) setDropTarget('');
        }}
        onDragLeave={(e) => e.target === e.currentTarget && setDropTarget(null)}
        onDrop={(e) => onDropFiles(e, '')}
        role="tree"
      >
        {isLoading || !tree ? (
          <div className="p-3">
            <Spinner className="text-ink-faint" />
          </div>
        ) : (
          <TreeLevel nodes={tree.children ?? []} depth={0} dir="" ctx={ctx} />
        )}
      </div>
      <Outline />

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogTitle>Delete {pendingDelete}?</DialogTitle>
          <DialogDescription>
            The file is removed from the project folder on disk. This cannot be undone from Research Studio.
          </DialogDescription>
          <DialogFooter>
            <Button onClick={() => setPendingDelete(null)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) void deleteEntry(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ImagePreview projectId={project.id} path={preview} onClose={() => setPreview(null)} />
    </aside>
  );
}
