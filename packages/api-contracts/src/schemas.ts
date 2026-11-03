import { z } from 'zod';
import {
  AUDIT_OUTCOMES,
  COMPILE_STATUSES,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  ERROR_CODES,
  FILE_KINDS,
  LATEX_ENGINES,
  PROJECT_TEMPLATES,
  THEMES,
  type AppSettings,
  type AuditEvent,
  type CompileJob,
  type Diagnostic,
  type FileTreeNode,
  type PdfRect,
  type Project,
  type ProjectFileContent,
  type SourceLocation,
  type ToolchainStatus,
} from '@research-studio/shared-types';

export const API_VERSION = 1;
export const API_PREFIX = '/api/v1';

/** Compile-time check that a schema's output type matches a shared domain type exactly. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

// ----------------------------------------------------------------- primitives

/** Project-relative path as typed by a client. Full validation happens in the runtime. */
export const ProjectPath = z.string().min(1).max(1024);
export const ProjectId = z.string().regex(/^[a-z0-9]{8,64}$/, 'Invalid project id');
export const JobId = z.string().regex(/^[a-z0-9]{8,64}$/, 'Invalid job id');
export const LatexEngineSchema = z.enum(LATEX_ENGINES);
export const FileKindSchema = z.enum(FILE_KINDS);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  rootPath: z.string(),
  mainFile: z.string(),
  engine: LatexEngineSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string().nullable(),
});
assertType<Exact<z.infer<typeof ProjectSchema>, Project>>();

export const FileTreeNodeSchema: z.ZodType<FileTreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(['file', 'directory']),
    kind: FileKindSchema.nullable(),
    size: z.number().nullable(),
    children: z.array(FileTreeNodeSchema).optional(),
  }),
);

export const ProjectFileContentSchema = z.object({
  path: z.string(),
  kind: FileKindSchema,
  content: z.string(),
  hash: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
});
assertType<Exact<z.infer<typeof ProjectFileContentSchema>, ProjectFileContent>>();

export const FileMetadataSchema = ProjectFileContentSchema.omit({ content: true });
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const DiagnosticSchema = z.object({
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  source: z.enum(DIAGNOSTIC_SOURCES),
  message: z.string(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  context: z.string().nullable(),
});
assertType<Exact<z.infer<typeof DiagnosticSchema>, Diagnostic>>();

export const CompileJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(COMPILE_STATUSES),
  engine: LatexEngineSchema,
  mainFile: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  exitCode: z.number().nullable(),
  pdfAvailable: z.boolean(),
  errorCount: z.number(),
  warningCount: z.number(),
  diagnostics: z.array(DiagnosticSchema),
  statusMessage: z.string().nullable(),
});
assertType<Exact<z.infer<typeof CompileJobSchema>, CompileJob>>();

export const PdfRectSchema = z.object({
  page: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
assertType<Exact<z.infer<typeof PdfRectSchema>, PdfRect>>();

export const SourceLocationSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
});
assertType<Exact<z.infer<typeof SourceLocationSchema>, SourceLocation>>();

export const AppSettingsSchema = z.object({
  theme: z.enum(THEMES),
  autosave: z.boolean(),
  autosaveDelayMs: z.number().int().min(300).max(60_000),
  editorFontSize: z.number().int().min(10).max(28),
  editorWordWrap: z.boolean(),
  compileOnSave: z.boolean(),
});
assertType<Exact<z.infer<typeof AppSettingsSchema>, AppSettings>>();

export const ToolchainStatusSchema = z.object({
  latexmk: z.object({ available: z.boolean(), version: z.string().nullable(), path: z.string().nullable() }),
  synctex: z.object({ available: z.boolean(), path: z.string().nullable() }),
  engines: z.object({ pdflatex: z.boolean(), xelatex: z.boolean(), lualatex: z.boolean() }),
});
assertType<Exact<z.infer<typeof ToolchainStatusSchema>, ToolchainStatus>>();

export const AuditEventSchema = z.object({
  id: z.number(),
  at: z.string(),
  action: z.string(),
  outcome: z.enum(AUDIT_OUTCOMES),
  actor: z.string().nullable(),
  projectId: z.string().nullable(),
  target: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
assertType<Exact<z.infer<typeof AuditEventSchema>, AuditEvent>>();

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

// ----------------------------------------------------------------- auth

export const HealthResponse = z.object({
  status: z.literal('ok'),
  name: z.literal('research-studio-runtime'),
  version: z.string(),
  apiVersion: z.number(),
});

export const CreateSessionRequest = z.object({
  pairingToken: z.string().min(16).max(256),
});
export const CreateSessionResponse = z.object({
  sessionToken: z.string(),
  expiresAt: z.string(),
});

export const WsTicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.string(),
});

export const RuntimeInfoResponse = z.object({
  version: z.string(),
  platform: z.string(),
  workspaceRoot: z.string(),
  toolchain: ToolchainStatusSchema,
  limits: z.object({
    maxUploadBytes: z.number(),
    compileTimeoutMs: z.number(),
    maxTextFileBytes: z.number(),
  }),
});

// ----------------------------------------------------------------- projects

export const ProjectNameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const CreateProjectRequest = z.object({
  name: ProjectNameSchema,
  template: z.enum(PROJECT_TEMPLATES).default('article'),
  author: z.string().trim().max(200).optional(),
  engine: LatexEngineSchema.default('pdflatex'),
});
export const UpdateProjectRequest = z
  .object({
    name: ProjectNameSchema.optional(),
    mainFile: ProjectPath.optional(),
    engine: LatexEngineSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const ProjectResponse = z.object({ project: ProjectSchema });
export const ProjectListResponse = z.object({ projects: z.array(ProjectSchema) });
export const DeleteProjectQuery = z.object({
  deleteFiles: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const ProjectParams = z.object({ projectId: ProjectId });
export const JobParams = z.object({ projectId: ProjectId, jobId: JobId });

// ----------------------------------------------------------------- files

export const TreeResponse = z.object({ tree: FileTreeNodeSchema });
export const PathQuery = z.object({ path: ProjectPath });

export const WriteFileRequest = z.object({
  path: ProjectPath,
  content: z.string(),
  /** sha256 of the version the client edited; omit to force-overwrite. */
  baseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export const WriteFileResponse = z.object({ file: FileMetadataSchema });

export const CreateEntryRequest = z.object({
  path: ProjectPath,
  type: z.enum(['file', 'directory']),
  content: z.string().optional(),
});
export const EntryResponse = z.object({
  entry: z.object({ path: z.string(), type: z.enum(['file', 'directory']) }),
});

export const RenameEntryRequest = z.object({ from: ProjectPath, to: ProjectPath });

export const UploadResponse = z.object({
  file: z.object({ path: z.string(), size: z.number() }),
});

export const LabelSymbolSchema = z.object({ label: z.string(), file: z.string(), line: z.number() });
export const CiteSymbolSchema = z.object({
  key: z.string(),
  file: z.string(),
  line: z.number(),
  type: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  year: z.string().nullable(),
});
export const SymbolsResponse = z.object({
  labels: z.array(LabelSymbolSchema),
  citations: z.array(CiteSymbolSchema),
});
export type LabelSymbol = z.infer<typeof LabelSymbolSchema>;
export type CiteSymbol = z.infer<typeof CiteSymbolSchema>;

// ----------------------------------------------------------------- compile

export const CompileResponse = z.object({ job: CompileJobSchema });
export const CancelCompileResponse = z.object({ job: CompileJobSchema.nullable() });
export const JobListResponse = z.object({ jobs: z.array(CompileJobSchema) });
export const JobDetailResponse = z.object({ job: CompileJobSchema, output: z.string().nullable() });

export const SynctexForwardRequest = z.object({
  file: ProjectPath,
  line: z.number().int().min(1),
  column: z.number().int().min(0).default(0),
});
export const SynctexForwardResponse = z.object({ rects: z.array(PdfRectSchema) });

export const SynctexInverseRequest = z.object({
  page: z.number().int().min(1),
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
});
export const SynctexInverseResponse = z.object({ location: SourceLocationSchema.nullable() });

// ----------------------------------------------------------------- settings & audit

export const SettingsResponse = z.object({ settings: AppSettingsSchema });
export const UpdateSettingsRequest = AppSettingsSchema.partial();
export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  projectId: ProjectId.optional(),
});
export const AuditResponse = z.object({ events: z.array(AuditEventSchema) });
