import {
  BookMarked,
  Bot,
  ChevronLeft,
  Quote,
  Library,
  Moon,
  PanelBottom,
  PanelLeft,
  Play,
  Settings2,
  Shapes,
  ShieldQuestion,
  ClipboardCheck,
  Square,
  Sun,
} from 'lucide-react';
import { useMemo } from 'react';
import { LATEX_ENGINES, type FileTreeNode, type LatexEngine, type Project } from '@research-studio/shared-types';
import { Button, cn, Select, Spinner, Tooltip } from '@research-studio/ui';
import { useTree, useUpdateProject, useUpdateSettings } from '../../lib/queries';
import { useResolvedTheme } from '../../lib/theme';
import { isActive, useCompile } from '../../stores/compile';
import { useLayout } from '../../stores/layout';
import { openLibrary, openLiterature, openReview, openVisual } from '../../lib/routes';
import { cancelCompile, compileProject, saveAll } from './actions';

const ENGINE_LABEL: Record<LatexEngine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

function texFiles(node: FileTreeNode | undefined): string[] {
  if (!node) return [];
  return (node.children ?? []).flatMap((c) =>
    c.type === 'directory' ? texFiles(c) : c.kind === 'tex' ? [c.path] : [],
  );
}

function PanelToggle({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} {...(shortcut ? { shortcut } : {})}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(pressed ? 'text-ink' : 'text-ink-faint')}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

export function TopBar({ project, onBack }: { project: Project; onBack: () => void }) {
  const { data: tree } = useTree(project.id);
  const update = useUpdateProject(project.id);
  const updateSettings = useUpdateSettings();
  const theme = useResolvedTheme();
  const job = useCompile((s) => s.jobs[project.id]);
  const layout = useLayout();
  const mains = useMemo(() => {
    const files = texFiles(tree);
    return files.includes(project.mainFile) ? files : [project.mainFile, ...files];
  }, [tree, project.mainFile]);
  const busy = isActive(job);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-rule bg-paper pl-1.5 pr-2">
      <Tooltip content="All projects">
        <Button variant="ghost" size="icon" aria-label="All projects" onClick={onBack}>
          <ChevronLeft />
        </Button>
      </Tooltip>
      <h1 className="min-w-0 truncate font-display text-[17px] leading-none text-ink" title={project.rootPath} data-testid="project-title">
        {project.name}
      </h1>

      <div className="ml-auto flex items-center gap-1.5">
        <Select
          aria-label="Main file"
          className="h-7 w-auto max-w-44 font-mono text-xs"
          value={project.mainFile}
          onChange={(e) => update.mutate({ mainFile: e.target.value })}
          title="Main file: the document latexmk compiles"
        >
          {mains.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Engine"
          className="h-7 w-auto text-xs"
          value={project.engine}
          onChange={(e) => update.mutate({ engine: e.target.value as LatexEngine })}
        >
          {LATEX_ENGINES.map((en) => (
            <option key={en} value={en}>
              {ENGINE_LABEL[en]}
            </option>
          ))}
        </Select>
        {busy ? (
          <Tooltip content="Stop compiling">
            <Button size="md" onClick={() => void cancelCompile()} data-testid="cancel-compile" className="min-w-[104px]">
              <Spinner />
              <span>Stop</span>
              <Square className="size-3 fill-current" />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content="Save all and compile" shortcut="Ctrl Enter">
            <Button variant="primary" size="md" onClick={() => void compileProject()} data-testid="compile" className="min-w-[104px]">
              <Play className="fill-current" />
              Compile
            </Button>
          </Tooltip>
        )}

        <div className="mx-1 h-5 w-px bg-rule" />
        <PanelToggle label="Explorer" shortcut="Ctrl B" pressed={layout.explorer} onClick={() => layout.toggle('explorer')}>
          <PanelLeft />
        </PanelToggle>
        <PanelToggle label="Problems and log" shortcut="Ctrl J" pressed={layout.diagnostics} onClick={() => layout.toggle('diagnostics')}>
          <PanelBottom />
        </PanelToggle>
        <PanelToggle label="Assistant" pressed={layout.assistant} onClick={() => layout.toggleAssistant()}>
          <Bot />
        </PanelToggle>
        <PanelToggle label="References" pressed={layout.references} onClick={() => layout.toggle('references')}>
          <Quote />
        </PanelToggle>
        <PanelToggle label="Evidence" pressed={layout.evidence} onClick={() => layout.toggle('evidence')}>
          <ShieldQuestion />
        </PanelToggle>
        <Tooltip content="Evidence review of the manuscript">
          <Button variant="ghost" size="icon" aria-label="Open evidence review" className="text-ink-faint" onClick={() => void saveAll().finally(() => openReview(project.id))} data-testid="open-review">
            <ClipboardCheck />
          </Button>
        </Tooltip>
        <Tooltip content="Search literature">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search literature"
            className="text-ink-faint"
            onClick={() => void saveAll().finally(() => openLiterature(project.id))}
          >
            <Library />
          </Button>
        </Tooltip>
        <Tooltip content="Open your library">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open your library"
            className="text-ink-faint"
            onClick={() => void saveAll().finally(() => openLibrary(project.id))}
          >
            <BookMarked />
          </Button>
        </Tooltip>
        <Tooltip content="Visual Studio: images to LaTeX">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open the Visual Studio"
            className="text-ink-faint"
            onClick={() => void saveAll().finally(() => openVisual(project.id))}
            data-testid="open-visual"
          >
            <Shapes />
          </Button>
        </Tooltip>
        <Tooltip content={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            className="text-ink-faint"
            onClick={() => updateSettings.mutate({ theme: theme === 'dark' ? 'light' : 'dark' })}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <Tooltip content="Settings">
          <Button variant="ghost" size="icon" aria-label="Settings" className="text-ink-faint" onClick={() => layout.setSettingsOpen(true)}>
            <Settings2 />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
