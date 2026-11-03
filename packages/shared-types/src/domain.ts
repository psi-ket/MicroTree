/** Core domain model shared by the runtime, the web app and all packages. */

export const LATEX_ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type LatexEngine = (typeof LATEX_ENGINES)[number];

export const FILE_KINDS = ['tex', 'bib', 'cls', 'sty', 'image', 'pdf', 'text', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const PROJECT_TEMPLATES = ['article', 'report', 'beamer', 'empty'] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

export interface Project {
  id: string;
  name: string;
  /** Directory name inside the workspace root. */
  slug: string;
  /** Absolute path on the runtime host. Informational only for the browser. */
  rootPath: string;
  /** Project-relative path of the compile entry point, e.g. `main.tex`. */
  mainFile: string;
  engine: LatexEngine;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  lastOpenedAt: IsoDateTime | null;
}

export interface FileTreeNode {
  /** Project-relative POSIX path (`chapters/intro.tex`). Root is `''`. */
  path: string;
  name: string;
  type: 'file' | 'directory';
  kind: FileKind | null;
  size: number | null;
  children?: FileTreeNode[];
}

export interface ProjectFileContent {
  path: string;
  kind: FileKind;
  content: string;
  /** Hex sha256 of the UTF-8 content; used for optimistic concurrency. */
  hash: string;
  size: number;
  modifiedAt: IsoDateTime;
}

export const COMPILE_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'error',
] as const;
export type CompileStatus = (typeof COMPILE_STATUSES)[number];

export const TERMINAL_COMPILE_STATUSES: readonly CompileStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'error',
];

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const DIAGNOSTIC_SOURCES = ['latex', 'bibtex', 'biber', 'latexmk', 'runtime'] as const;
export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];

export interface Diagnostic {
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  message: string;
  /** Project-relative path when it could be attributed to a project file. */
  file: string | null;
  line: number | null;
  /** Extra context from the log (e.g. `l.12 \foo`). */
  context: string | null;
}

export interface CompileJob {
  id: string;
  projectId: string;
  status: CompileStatus;
  engine: LatexEngine;
  mainFile: string;
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  durationMs: number | null;
  exitCode: number | null;
  /** True when a PDF was produced (even if errors were reported). */
  pdfAvailable: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: Diagnostic[];
  /** Human readable reason for `error` / `cancelled`. */
  statusMessage: string | null;
}

/** A rectangle in PDF user space (big points, origin top-left of the page). */
export interface PdfRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEMES)[number];

export interface AppSettings {
  theme: ThemePreference;
  autosave: boolean;
  autosaveDelayMs: number;
  editorFontSize: number;
  editorWordWrap: boolean;
  compileOnSave: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  autosave: true,
  autosaveDelayMs: 1200,
  editorFontSize: 14,
  editorWordWrap: true,
  compileOnSave: false,
};

export const AUDIT_OUTCOMES = ['success', 'denied', 'error'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditEvent {
  id: number;
  at: IsoDateTime;
  action: string;
  outcome: AuditOutcome;
  actor: string | null;
  projectId: string | null;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface ToolchainStatus {
  latexmk: { available: boolean; version: string | null; path: string | null };
  synctex: { available: boolean; path: string | null };
  engines: Record<LatexEngine, boolean>;
}

/** One file changed outside Research Studio, as detected by the runtime's watcher. */
export interface FileChange {
  /** The file's path now (for `renamed`, the new path). */
  path: string;
  change: 'added' | 'changed' | 'deleted' | 'renamed';
  /** Previous path of a renamed file. */
  from?: string;
}
