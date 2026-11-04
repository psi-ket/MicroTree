import { z } from 'zod';
import {
  APPROVAL_STATUSES,
  COMPILATION_STATUSES,
  INSERTION_STATUSES,
  PRIVACY_MODES,
  VERSION_ORIGINS,
  VISUAL_ARTIFACT_TYPES,
  VISUAL_ASSET_KINDS,
  VISUAL_TASK_STATUSES,
  VISUAL_TASK_TYPES,
} from '@research-studio/shared-types';
import { DiagnosticSchema } from './schemas';

// Visual intelligence (M4). Images, tasks and artifacts are addressed by ID;
// no response contains a file-system path.

const Id = z.string().min(3).max(80).regex(/^[A-Za-z0-9_:-]+$/);
const ProjectPathSchema = z.string().min(1).max(1024);

export const PreprocessOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('auto-orient') }),
  z.object({ op: z.literal('rotate'), degrees: z.number().min(-360).max(360) }),
  z.object({ op: z.literal('crop'), left: z.number().min(0), top: z.number().min(0), width: z.number().min(1), height: z.number().min(1) }),
  z.object({ op: z.literal('resize'), maxWidth: z.number().int().min(8).max(12_000), maxHeight: z.number().int().min(8).max(12_000) }),
  z.object({ op: z.literal('grayscale') }),
  z.object({ op: z.literal('contrast'), factor: z.number().min(0.2).max(5) }),
  z.object({ op: z.literal('normalize') }),
  z.object({ op: z.literal('sharpen') }),
  z.object({ op: z.literal('upscale'), factor: z.number().min(1).max(4) }),
]);

export const VisualProvenanceSchema = z.union([
  z.object({ source: z.enum(['upload', 'clipboard']), fileName: z.string().nullable() }),
  z.object({ source: z.literal('project-file'), projectId: z.string(), path: z.string() }),
  z.object({
    source: z.literal('pdf-region'),
    attachmentId: z.string(),
    libraryItemId: z.string(),
    pdfSha256: z.string(),
    pageNumber: z.number().int(),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), pageWidth: z.number(), pageHeight: z.number() }),
    renderScale: z.number(),
  }),
  z.object({ source: z.literal('generated'), fromAssetId: z.string().nullable(), description: z.string() }),
]);

export const VisualAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(VISUAL_ASSET_KINDS),
  parentAssetId: z.string().nullable(),
  originalAssetId: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int(),
  sha256: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  operations: z.array(PreprocessOperationSchema),
  preprocessVersion: z.string().nullable(),
  provenance: VisualProvenanceSchema,
  label: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
});
export type VisualAsset = z.infer<typeof VisualAssetSchema>;

export const VisualAssetResponse = z.object({ asset: VisualAssetSchema, working: VisualAssetSchema, removed: z.array(z.string()) });
export const VisualAssetDetailResponse = z.object({ asset: VisualAssetSchema, lineage: z.array(VisualAssetSchema) });
export const VisualAssetListResponse = z.object({ assets: z.array(VisualAssetSchema) });
export const VariantRequest = z.object({ operations: z.array(PreprocessOperationSchema).min(1).max(20), label: z.string().max(120).optional() }).strict();
export const ProjectImageRequest = z.object({ projectId: z.string().min(1).max(80), path: ProjectPathSchema }).strict();
export const PdfRegionFields = z.object({
  attachmentId: Id,
  pageNumber: z.coerce.number().int().min(1).max(100_000),
  x: z.coerce.number().min(0),
  y: z.coerce.number().min(0),
  width: z.coerce.number().positive(),
  height: z.coerce.number().positive(),
  pageWidth: z.coerce.number().positive(),
  pageHeight: z.coerce.number().positive(),
  renderScale: z.coerce.number().min(0.5).max(8),
});
export const AssetParams = z.object({ assetId: Id });

export const VisualTaskSchema = z.object({
  id: z.string(),
  taskType: z.enum(VISUAL_TASK_TYPES),
  resolvedType: z.enum(VISUAL_TASK_TYPES).nullable(),
  projectId: z.string().nullable(),
  sourceAssetId: z.string().nullable(),
  inputAssetId: z.string().nullable(),
  sourceAttachmentId: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  providerId: z.string().nullable(),
  providerKind: z.string().nullable(),
  model: z.string().nullable(),
  privacyMode: z.enum(PRIVACY_MODES),
  consentAt: z.string().nullable(),
  promptVersion: z.string(),
  status: z.enum(VISUAL_TASK_STATUSES),
  progress: z.string().nullable(),
  error: z.string().nullable(),
  choices: z.array(z.enum(VISUAL_TASK_TYPES)).nullable(),
  usage: z.record(z.string(), z.number().nullable()).nullable(),
  artifactId: z.string().nullable(),
  artifactVersion: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type VisualTask = z.infer<typeof VisualTaskSchema>;

const Target = { providerId: Id, model: z.string().trim().min(1).max(200).regex(/^[^\s-][^\s]*$/, 'Invalid model name'), consent: z.boolean().default(false) };

export const CreateVisualTaskRequest = z
  .object({
    taskType: z.enum(VISUAL_TASK_TYPES),
    assetId: Id.nullable().default(null),
    text: z.string().max(8000).nullable().default(null),
    projectId: z.string().max(80).nullable().default(null),
    layout: z.enum(['preserve', 'improve', 'publication', 'alternative']).optional(),
    imageDetail: z.enum(['low', 'high', 'auto']).optional(),
    ...Target,
  })
  .strict();
export const ReconstructRequest = CreateVisualTaskRequest.omit({ taskType: true });
export const CircuitReconstructRequest = ReconstructRequest.extend({ circuitType: z.enum(['quantum', 'electrical']) });
export const ChooseTaskTypeRequest = z.object({ taskType: z.enum(VISUAL_TASK_TYPES) }).strict();
export const RetryTaskRequest = z.object({ consent: z.boolean().default(false) }).strict();
export const TasksQuery = z.object({ projectId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const AssetsQuery = z.object({ projectId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const ArtifactsQuery = z.object({ projectId: z.string().max(80).optional() });
export const CompareQuery = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) });
export const ExportQuery = z.object({ format: z.enum(['tex', 'standalone', 'csv', 'json']).default('tex') });
export const InsertionsQuery = z.object({ projectId: z.string().min(1).max(80) });
export const RefineResponse = z.object({ version: z.lazy(() => ArtifactVersionSchema), summary: z.string(), changes: z.array(z.string()), topologyChanges: z.array(z.string()), ambiguities: z.array(z.string()) });
export const VisualTaskResponse = z.object({ task: VisualTaskSchema });
export const VisualTaskListResponse = z.object({ tasks: z.array(VisualTaskSchema) });
export const TaskParams = z.object({ taskId: Id });

export const ArtifactVersionSchema = z.object({
  id: z.string(),
  versionNumber: z.number().int(),
  sourceCode: z.string(),
  structuredData: z.record(z.string(), z.unknown()).nullable(),
  dataCsv: z.string().nullable(),
  warnings: z.array(z.string()),
  origin: z.enum(VERSION_ORIGINS),
  changeDescription: z.string(),
  packages: z.array(z.string()),
  compilationStatus: z.enum(COMPILATION_STATUSES),
  diagnostics: z.array(DiagnosticSchema),
  compileLog: z.string().nullable(),
  previewAssetId: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: z.string(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const VisualArtifactSchema = z.object({
  id: z.string(),
  artifactType: z.enum(VISUAL_ARTIFACT_TYPES),
  title: z.string(),
  projectId: z.string().nullable(),
  sourceAssetId: z.string().nullable(),
  currentVersion: z.number().int(),
  approval: z.enum(APPROVAL_STATUSES),
  approvedAt: z.string().nullable(),
  approvedVersion: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VisualArtifact = z.infer<typeof VisualArtifactSchema>;

export const ArtifactResponse = z.object({ artifact: VisualArtifactSchema, version: ArtifactVersionSchema });
export const ArtifactListResponse = z.object({ artifacts: z.array(VisualArtifactSchema.extend({ compilationStatus: z.enum(COMPILATION_STATUSES) })) });
export const ArtifactVersionsResponse = z.object({ versions: z.array(ArtifactVersionSchema) });
export const ArtifactParams = z.object({ artifactId: Id });
export const VersionParams = z.object({ artifactId: Id, version: z.coerce.number().int().min(1) });

export const ManualEditRequest = z.object({ sourceCode: z.string().min(1).max(200_000), dataCsv: z.string().max(5_000_000).nullable().optional(), changeDescription: z.string().max(500).default('Edited by hand') }).strict();
export const RestoreRequest = z.object({ version: z.number().int().min(1) }).strict();
export const ValidateRequest = z.object({ sourceCode: z.string().max(200_000).optional() }).strict();
export const ValidateResponse = z.object({ issues: z.array(z.object({ severity: z.enum(['error', 'warning']), message: z.string(), at: z.number().nullable() })), packages: z.array(z.string()), missingPackages: z.array(z.string()) });
export const CompileRequestBody = z.object({ version: z.number().int().min(1).optional() }).strict();
export const ApproveRequest = z.object({ version: z.number().int().min(1) }).strict();
export const RefineRequest = z.object({ instruction: z.string().trim().min(1).max(4000), ...Target }).strict();
const AxisCalibration = z.object({
  scale: z.enum(['linear', 'log']).optional(),
  reversed: z.boolean().optional(),
  label: z.string().max(200).nullable().optional(),
  unit: z.string().max(60).nullable().optional(),
  calibration: z.array(z.object({ pixel: z.number(), value: z.number() })).max(20).optional(),
});
export const PlotUpdateRequest = z
  .object({
    style: z
      .object({
        width: z.string().max(20),
        height: z.string().max(20),
        grid: z.enum(['none', 'major', 'both']),
        monochrome: z.boolean(),
        legend: z.enum(['north east', 'north west', 'south east', 'south west', 'outer north east', 'none']),
        plotType: z.enum(['line', 'scatter', 'bar', 'histogram']),
        title: z.string().max(300).nullable(),
      })
      .partial()
      .optional(),
    xAxis: AxisCalibration.optional(),
    yAxis: AxisCalibration.optional(),
    exactCsv: z.string().max(5_000_000).optional(),
  })
  .strict();
export const CompareResponse = z.object({ from: z.number().int(), to: z.number().int(), diff: z.array(z.object({ kind: z.enum(['same', 'added', 'removed']), text: z.string() })), structuredChanged: z.boolean() });

export const InsertionOptionsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    version: z.number().int().min(1),
    targetFile: ProjectPathSchema.nullable().default(null),
    afterLine: z.number().int().min(0).max(1_000_000).nullable().default(null),
    directory: z.string().max(200).default('figures'),
    label: z.string().max(60).nullable().default(null),
    caption: z.string().max(2000).nullable().default(null),
    addPreamble: z.boolean().default(false),
  })
  .strict();
export const InsertionPlanSchema = z.object({
  artifactId: z.string(),
  versionNumber: z.number().int(),
  createdFiles: z.array(z.object({ path: z.string(), content: z.string() })),
  modifiedFiles: z.array(z.object({ path: z.string(), before: z.string(), after: z.string(), baseHash: z.string() })),
  missingPackages: z.array(z.string()),
  preambleLines: z.array(z.string()),
  snippet: z.string(),
  warnings: z.array(z.string()),
  /** Fingerprint of the reviewed plan; applying a different plan is refused. */
  planHash: z.string(),
});
export type InsertionPlan = z.infer<typeof InsertionPlanSchema>;
export const ApplyInsertionRequest = InsertionOptionsSchema.extend({ planHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const InsertionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  versionNumber: z.number().int(),
  createdFiles: z.array(z.object({ path: z.string(), hash: z.string() })),
  modifiedFiles: z.array(z.object({ path: z.string(), beforeHash: z.string(), afterHash: z.string() })),
  status: z.enum(INSERTION_STATUSES),
  createdAt: z.string(),
  rolledBackAt: z.string().nullable(),
});
export type Insertion = z.infer<typeof InsertionSchema>;
export const InsertionResponse = z.object({ insertion: InsertionSchema });
export const InsertionListResponse = z.object({ insertions: z.array(InsertionSchema) });
export const RollbackResponse = z.object({ insertion: InsertionSchema, restored: z.array(z.string()), removed: z.array(z.string()) });
export const InsertionParams = z.object({ insertionId: Id });

export const VisualProviderSchema = z.object({
  id: z.string(),
  kind: z.string(),
  displayName: z.string(),
  defaultModel: z.string().nullable(),
  vision: z.boolean(),
  structuredOutput: z.boolean(),
  privacyMode: z.enum(PRIVACY_MODES),
  host: z.string().nullable(),
  usable: z.boolean(),
  problem: z.string().nullable(),
});
export const VisualProvidersResponse = z.object({ providers: z.array(VisualProviderSchema), compileAvailable: z.boolean() });
export const ProviderCheckQuery = z.object({ model: z.string().min(1).max(200), taskType: z.enum(VISUAL_TASK_TYPES).default('equation') });
export const ProviderCheckResponse = z.object({ ok: z.boolean(), privacyMode: z.enum(PRIVACY_MODES), needsConsent: z.boolean(), modelVision: z.boolean().nullable(), problem: z.string().nullable(), estimatedImageTokens: z.number().int().nullable() });
