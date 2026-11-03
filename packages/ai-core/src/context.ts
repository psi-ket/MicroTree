import {
  classifyFile,
  extractCitations,
  extractFileReferences,
  extractOutline,
  normalizeProjectPath,
  parseBibEntries,
} from '@research-studio/document-engine';
import {
  StudioError,
  type ContextItemKind,
  type ContextItemSummary,
  type Diagnostic,
  type FileKind,
} from '@research-studio/shared-types';
import { lineAtOffset, offsetAt, sliceLines, truncate } from './text';

/** What the browser tells the runtime about the editor. Paths are validated here. */
export interface ContextRequest {
  activeFile: string | null;
  /** 1-based, end exclusive in the Monaco sense (end column is after the last character). */
  selection: { file: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
  /** The selected text as the editor saw it, used to detect a stale selection. */
  selectionText: string | null;
  cursor: { line: number; column: number } | null;
  openTabs: string[];
  attachedFiles: string[];
}

/** Read access to one project, implemented by the runtime on top of its path guard. */
export interface ContextSource {
  mainFile: string;
  /** `null` when the file does not exist or is not text. */
  readText(path: string): Promise<{ content: string; hash: string } | null>;
  listFiles(): Promise<{ path: string; kind: FileKind; size: number | null }[]>;
  diagnostics(): Diagnostic[];
}

export interface ContextBudget {
  /** Upper bound for everything rendered into the prompt. */
  totalChars: number;
  /** Files at or below this size are included whole when active. */
  wholeFileChars: number;
  /** Lines shown around the selection or cursor otherwise. */
  windowLines: number;
  selectionChars: number;
  treeEntries: number;
  outlineEntries: number;
  diagnostics: number;
  bibEntries: number;
  attachedFileChars: number;
  attachedFiles: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalChars: 60_000,
  wholeFileChars: 14_000,
  windowLines: 60,
  selectionChars: 16_000,
  treeEntries: 250,
  outlineEntries: 80,
  diagnostics: 20,
  bibEntries: 20,
  attachedFileChars: 12_000,
  attachedFiles: 4,
};

export interface ResolvedSelection {
  file: string;
  text: string;
  start: number;
  end: number;
  /** Hash of the file content the offsets refer to. */
  hash: string;
  startLine: number;
  endLine: number;
}

export interface AssembledContext {
  items: ContextItemSummary[];
  /** Rendered context, fenced as untrusted data. Empty when there is nothing to send. */
  rendered: string;
  selection: ResolvedSelection | null;
  activeFile: { path: string; hash: string } | null;
}

interface Part {
  kind: ContextItemKind;
  label: string;
  body: string;
  truncated: boolean;
  /** Lower numbers survive budget cuts. */
  priority: number;
}

const FENCE_TAGS = /<(\/?)(project-context|context-item|rs-[a-z-]+)/gi;

/**
 * Project content is data, not instructions. Neutralize anything that could
 * close our fences or imitate the edit protocol.
 */
export function neutralize(text: string): string {
  return text.replace(FENCE_TAGS, '&lt;$1$2');
}

function safePath(input: string): string | null {
  try {
    return normalizeProjectPath(input);
  } catch {
    return null;
  }
}

async function resolveSelection(source: ContextSource, request: ContextRequest): Promise<ResolvedSelection | null> {
  const sel = request.selection;
  if (!sel) return null;
  const file = safePath(sel.file);
  if (!file) throw new StudioError('VALIDATION_FAILED', 'Invalid selection path');
  const doc = await source.readText(file);
  if (!doc) throw new StudioError('NOT_FOUND', `Cannot read ${file}`);
  const start = offsetAt(doc.content, sel.startLine, sel.startColumn);
  const end = offsetAt(doc.content, sel.endLine, sel.endColumn);
  if (end <= start) return null;
  const text = doc.content.slice(start, end);
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  if (request.selectionText !== null && lf(request.selectionText) !== lf(text)) {
    throw new StudioError(
      'STALE_PROPOSAL',
      'The selection no longer matches the saved file. Save the file and select the text again.',
      { file },
    );
  }
  return {
    file,
    text,
    start,
    end,
    hash: doc.hash,
    startLine: lineAtOffset(doc.content, start),
    endLine: lineAtOffset(doc.content, end),
  };
}

function numbered(text: string, firstLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${String(firstLine + i).padStart(4)}| ${line}`)
    .join('\n');
}

/** Cite keys used near the user's focus, in order of appearance. */
function citedKeys(text: string): string[] {
  return [...new Set(extractCitations(text).map((c) => c.key))];
}

/**
 * Assemble a bounded context for one request. Only files the request points
 * at (plus the document structure) are read; the whole project is never sent.
 */
export async function buildContext(
  source: ContextSource,
  request: ContextRequest,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): Promise<AssembledContext> {
  const parts: Part[] = [];
  const selection = await resolveSelection(source, request);
  const activePath = request.activeFile ? safePath(request.activeFile) : null;
  if (request.activeFile && !activePath) throw new StudioError('VALIDATION_FAILED', 'Invalid active file path');

  // Selection.
  let focusText = '';
  if (selection) {
    const t = truncate(selection.text, budget.selectionChars);
    focusText = selection.text;
    parts.push({
      kind: 'selection',
      label: `${selection.file}, lines ${selection.startLine}–${selection.endLine}`,
      body: t.text,
      truncated: t.truncated,
      priority: 0,
    });
  }

  // Active file (whole when small, else a window around the selection/cursor).
  let activeFile: AssembledContext['activeFile'] = null;
  const activeTarget = selection?.file ?? activePath;
  if (activeTarget) {
    const doc = await source.readText(activeTarget);
    if (doc) {
      activeFile = { path: activeTarget, hash: doc.hash };
      const lines = doc.content.split('\n').length;
      if (doc.content.length <= budget.wholeFileChars) {
        parts.push({
          kind: 'active-file',
          label: `${activeTarget} (whole file, ${lines} lines)`,
          body: numbered(doc.content, 1),
          truncated: false,
          priority: 1,
        });
        if (!focusText) focusText = doc.content;
      } else {
        const center = selection
          ? Math.round((selection.startLine + selection.endLine) / 2)
          : (request.cursor?.line ?? 1);
        const half = Math.round(budget.windowLines / 2);
        const span = selection ? selection.endLine - selection.startLine : 0;
        const from = Math.max(1, Math.min(center, selection?.startLine ?? center) - half);
        const to = Math.min(lines, from + budget.windowLines + span);
        const windowText = sliceLines(doc.content, from, to);
        parts.push({
          kind: 'active-file',
          label: `${activeTarget}, lines ${from}–${to} of ${lines}`,
          body: numbered(windowText, from),
          truncated: true,
          priority: 1,
        });
        if (!focusText) focusText = windowText;
      }
    }
  }

  // Compile diagnostics (the runtime's own record, not the browser's).
  const diagnostics = source
    .diagnostics()
    .filter((d) => d.severity !== 'info')
    .sort((a, b) => Number(b.file === activeTarget) - Number(a.file === activeTarget));
  if (diagnostics.length) {
    const shown = diagnostics.slice(0, budget.diagnostics);
    parts.push({
      kind: 'diagnostics',
      label: `${diagnostics.length} from the last compile`,
      body: shown
        .map((d) => `${d.severity} [${d.source}] ${d.file ?? '?'}:${d.line ?? '?'} ${d.message}${d.context ? ` (${d.context})` : ''}`)
        .join('\n'),
      truncated: shown.length < diagnostics.length,
      priority: 2,
    });
  }

  // File structure and document outline.
  const files = await source.listFiles();
  if (files.length) {
    const shown = files.slice(0, budget.treeEntries);
    parts.push({
      kind: 'file-tree',
      label: `${files.length} files`,
      body: shown.map((f) => `${f.path}${f.kind === 'image' || f.kind === 'pdf' ? ' (binary)' : ''}`).join('\n'),
      truncated: shown.length < files.length,
      priority: 4,
    });
  }

  const outline = await documentOutline(source, budget.outlineEntries);
  if (outline.entries.length) {
    parts.push({
      kind: 'outline',
      label: `${outline.entries.length} headings from ${source.mainFile}`,
      body: outline.entries.join('\n'),
      truncated: outline.truncated,
      priority: 3,
    });
  }

  // Bibliography entries cited in the focus text.
  const keys = citedKeys(focusText);
  if (keys.length) {
    const bibFiles = files.filter((f) => f.kind === 'bib').slice(0, 8);
    const found = new Map<string, string>();
    for (const bib of bibFiles) {
      const doc = await source.readText(bib.path);
      if (!doc) continue;
      for (const entry of parseBibEntries(doc.content)) {
        if (keys.includes(entry.key) && !found.has(entry.key)) {
          found.set(
            entry.key,
            `@${entry.type}{${entry.key}: ${entry.author ?? 'unknown author'}, "${entry.title ?? 'untitled'}", ${entry.year ?? 'n.d.'} (${bib.path})`,
          );
        }
      }
    }
    const lines = keys.slice(0, budget.bibEntries).map((k) => found.get(k) ?? `${k}: not found in any .bib file`);
    parts.push({
      kind: 'bibliography',
      label: `${found.size} of ${keys.length} cited entries`,
      body: lines.join('\n'),
      truncated: keys.length > budget.bibEntries,
      priority: 2,
    });
  }

  // Open tabs (names only).
  const tabs = request.openTabs.map(safePath).filter((p): p is string => p !== null && p !== activeTarget);
  if (tabs.length) {
    parts.push({ kind: 'open-tabs', label: `${tabs.length} other open files`, body: tabs.slice(0, 20).join('\n'), truncated: tabs.length > 20, priority: 5 });
  }

  // Files the user attached explicitly.
  for (const raw of request.attachedFiles.slice(0, budget.attachedFiles)) {
    const file = safePath(raw);
    if (!file) throw new StudioError('VALIDATION_FAILED', `Invalid attached file path: ${raw.slice(0, 200)}`);
    if (file === activeTarget) continue;
    const doc = await source.readText(file);
    if (!doc) continue;
    const t = truncate(doc.content, budget.attachedFileChars);
    parts.push({ kind: 'attached-file', label: file, body: numbered(t.text, 1), truncated: t.truncated, priority: 1 });
  }

  return { ...render(parts, budget.totalChars), selection, activeFile };
}

async function documentOutline(source: ContextSource, max: number): Promise<{ entries: string[]; truncated: boolean }> {
  const entries: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const visit = async (file: string, depth: number) => {
    if (seen.has(file) || depth > 4 || seen.size > 40) return;
    seen.add(file);
    const doc = await source.readText(file);
    if (!doc) return;
    for (const h of extractOutline(doc.content)) {
      if (entries.length >= max) {
        truncated = true;
        return;
      }
      entries.push(`${'  '.repeat(Math.max(0, h.level - 1))}\\${h.kind}{${h.title}}  (${file}:${h.line})`);
    }
    for (const ref of extractFileReferences(doc.content)) {
      if (ref.kind !== 'input' && ref.kind !== 'include') continue;
      const target = safePath(/\.[a-z]+$/i.test(ref.target) ? ref.target : `${ref.target}.tex`);
      if (target && classifyFile(target) === 'tex') await visit(target, depth + 1);
    }
  };
  await visit(source.mainFile, 0);
  return { entries, truncated };
}

function render(parts: Part[], totalChars: number): { items: ContextItemSummary[]; rendered: string } {
  // Drop the least important parts first when over budget.
  const kept = [...parts];
  const size = () => kept.reduce((n, p) => n + p.body.length + p.label.length + 64, 0);
  while (kept.length > 1 && size() > totalChars) {
    let worst = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority > kept[worst]!.priority) worst = i;
    kept.splice(worst, 1);
  }
  if (kept.length === 1 && size() > totalChars) {
    const t = truncate(kept[0]!.body, totalChars - 200);
    kept[0] = { ...kept[0]!, body: t.text, truncated: kept[0]!.truncated || t.truncated };
  }
  const items = kept.map((p) => ({ kind: p.kind, label: p.label, chars: p.body.length, truncated: p.truncated }));
  if (!kept.length) return { items, rendered: '' };
  const body = kept
    .map((p) => `<context-item kind="${p.kind}" label="${neutralize(p.label).replace(/"/g, "'")}">\n${neutralize(p.body)}\n</context-item>`)
    .join('\n');
  return { items, rendered: `<project-context>\n${body}\n</project-context>` };
}
