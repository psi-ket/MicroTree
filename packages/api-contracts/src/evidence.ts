import { z } from 'zod';
import {
  ANCHOR_STATUSES,
  ASSESSMENT_STATES,
  ASSESSMENTS,
  ATOMICITY,
  CITATION_PLACEMENTS,
  CITATION_RECOMMENDATION_STATUSES,
  CITE_COMMANDS,
  CLAIM_REVIEW_STATES,
  CLAIM_STATUSES,
  CONFLICT_CATEGORIES,
  EVIDENCE_JOB_KINDS,
  EVIDENCE_JOB_STATUSES,
  EVIDENCE_LEVELS,
  EVIDENCE_MODEL_TASKS,
  EVIDENCE_PRIVACY_MODES,
  EVIDENCE_RECORD_STATUSES,
  REVIEW_DECISIONS,
  REVIEW_SCOPES,
  RETRIEVAL_METHODS,
  UNCERTAINTY,
  WRITING_OPERATIONS,
  WRITING_SUGGESTION_STATUSES,
} from '@research-studio/shared-types';
import { DocumentCoordinateSchema } from './documents';

// Evidence-linked writing (M5). Claims, evidence and jobs are addressed by
// ID and always belong to one project; no response contains a file-system path.

const Id = z.string().min(3).max(120).regex(/^[A-Za-z0-9_:.-]+$/);
const ProviderId = z.string().regex(/^[a-z0-9-]{2,64}$/);
const ModelName = z.string().trim().min(1).max(200).regex(/^[^\s-][^\s]*$/, 'Invalid model name');

/** A model for one task, with the user's consent when it runs off this computer. */
export const ModelChoiceSchema = z.object({ providerId: ProviderId, model: ModelName, consent: z.boolean().default(false) }).strict();

const Counts = z.object(Object.fromEntries(ASSESSMENTS.map((a) => [a, z.number().int()])) as Record<(typeof ASSESSMENTS)[number], z.ZodNumber>);

export const ClaimSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  documentId: z.string(),
  sourceBlockId: z.string(),
  sourceSentenceId: z.string().nullable(),
  originalText: z.string(),
  claimText: z.string(),
  span: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
  normalizedText: z.string(),
  claimType: z.string(),
  atomicity: z.enum(ATOMICITY),
  entities: z.array(z.string()),
  concepts: z.array(z.string()),
  quantities: z.array(z.object({ value: z.string(), unit: z.string().optional(), context: z.string().optional() })),
  assumptions: z.array(z.string()),
  documentRevision: z.string(),
  textHash: z.string(),
  status: z.enum(CLAIM_STATUSES),
  reviewState: z.enum(CLAIM_REVIEW_STATES),
  requiresEvidence: z.boolean(),
  exclusionReason: z.string().nullable(),
  derivedFrom: z.array(z.string()),
  extractedBy: z.string(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  promptVersion: z.string().nullable(),
  note: z.string().nullable(),
  anchor: z.object({
    filePath: z.string(),
    sectionPath: z.string(),
    mappingStatus: z.enum(ANCHOR_STATUSES),
    previousText: z.string().nullable(),
    /** Lines of the sentence in its file (1-based), when it is still in the text. */
    lines: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
  }),
  cited: z.array(z.string()),
  counts: Counts,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClaimView = z.infer<typeof ClaimSchema>;

export const EvidenceSourceSchema = z.object({
  id: z.string(),
  level: z.enum(EVIDENCE_LEVELS),
  scholarlyWorkId: z.string().nullable(),
  libraryItemId: z.string().nullable(),
  attachmentId: z.string().nullable(),
  extractionId: z.string().nullable(),
  passageId: z.string().nullable(),
  sourceSha256: z.string().nullable(),
  extractorVersion: z.string().nullable(),
  externalId: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  publicationType: z.string().nullable(),
  sectionPath: z.string().nullable(),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  coordinates: z.array(DocumentCoordinateSchema),
  text: z.string(),
  contextBefore: z.string().nullable(),
  contextAfter: z.string().nullable(),
  location: z.string(),
  createdAt: z.string(),
});

export const AssessmentSchema = z.object({
  id: z.string(),
  assessment: z.enum(ASSESSMENTS),
  explanation: z.string(),
  supportingText: z.string().nullable(),
  excerptVerified: z.boolean(),
  supportedSubclaims: z.array(z.string()),
  unsupportedSubclaims: z.array(z.string()),
  contradictoryStatements: z.array(z.string()),
  limitations: z.array(z.string()),
  uncertainty: z.enum(UNCERTAINTY),
  validationNotes: z.array(z.string()),
  modelProvider: z.string(),
  modelId: z.string(),
  promptVersion: z.string(),
  assessmentVersion: z.string(),
  status: z.enum(ASSESSMENT_STATES),
  createdAt: z.string(),
  supersededAt: z.string().nullable(),
});
export type AssessmentView = z.infer<typeof AssessmentSchema>;

export const ReviewSchema = z.object({ id: z.string(), decision: z.enum(REVIEW_DECISIONS), reclassifiedAs: z.enum(ASSESSMENTS).nullable(), note: z.string().nullable(), assessmentId: z.string().nullable(), createdAt: z.string() });

export const EvidenceRecordSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  status: z.enum(EVIDENCE_RECORD_STATUSES),
  retrievalMethod: z.enum(RETRIEVAL_METHODS),
  queryVariant: z.string().nullable(),
  relevanceRank: z.number().int().nullable(),
  keywordRank: z.number().int().nullable(),
  semanticRank: z.number().int().nullable(),
  fusedScore: z.number().nullable(),
  retrievalIndexVersion: z.string().nullable(),
  retrievedAt: z.string(),
  source: EvidenceSourceSchema,
  /** The current AI assessment (null when not assessed yet). */
  assessment: AssessmentSchema.nullable(),
  /** Earlier AI assessments, newest first (never overwritten). */
  history: z.array(AssessmentSchema),
  /** The researcher's decisions, newest first, kept apart from AI assessments. */
  reviews: z.array(ReviewSchema),
  /** The category in effect: the researcher's when they reclassified or accepted it, else the AI's. */
  effective: z.enum(ASSESSMENTS).nullable(),
  /** Grouped under an earlier passage of the same paper. */
  samePaperAs: z.string().nullable(),
});
export type EvidenceRecordView = z.infer<typeof EvidenceRecordSchema>;

export const ConflictSchema = z.object({
  id: z.string(),
  supportingRecordId: z.string(),
  opposingRecordId: z.string(),
  category: z.enum(CONFLICT_CATEGORIES),
  explanation: z.string(),
  differences: z.array(z.object({ aspect: z.string(), supporting: z.string(), opposing: z.string() })),
  uncertainty: z.enum(UNCERTAINTY),
  notes: z.array(z.string()),
  modelId: z.string(),
  status: z.enum(ASSESSMENT_STATES),
  createdAt: z.string(),
});

export const CitationRecommendationSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  libraryItemId: z.string().nullable(),
  scholarlyWorkId: z.string().nullable(),
  citationKey: z.string(),
  keySource: z.string(),
  recommendedPlacement: z.enum(CITATION_PLACEMENTS),
  evidenceRecordId: z.string().nullable(),
  evidenceAssessmentId: z.string().nullable(),
  reason: z.string(),
  status: z.enum(CITATION_RECOMMENDATION_STATUSES),
  proposalId: z.string().nullable(),
  paper: z.object({ title: z.string(), authors: z.array(z.string()), year: z.number().int().nullable(), doi: z.string().nullable() }),
  passage: z.object({ text: z.string(), location: z.string() }).nullable(),
  assessment: z.enum(ASSESSMENTS).nullable(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  needsBibChange: z.boolean(),
  createdAt: z.string(),
});

export const ClaimDetailResponse = z.object({ claim: ClaimSchema, evidence: z.array(EvidenceRecordSchema), conflicts: z.array(ConflictSchema), recommendations: z.array(CitationRecommendationSchema) });
export const ClaimResponse = z.object({ claim: ClaimSchema });
export const ClaimListResponse = z.object({ claims: z.array(ClaimSchema), manuscript: z.object({ rootFile: z.string(), revision: z.string(), files: z.array(z.string()), missingIncludes: z.array(z.string()) }) });
export const EvidenceListResponse = z.object({ evidence: z.array(EvidenceRecordSchema), conflicts: z.array(ConflictSchema) });

export const EvidenceJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(EVIDENCE_JOB_KINDS),
  status: z.enum(EVIDENCE_JOB_STATUSES),
  progress: z.object({ done: z.number().int(), total: z.number().int(), message: z.string().nullable() }),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  providerId: z.string().nullable(),
  providerKind: z.string().nullable(),
  modelId: z.string().nullable(),
  privacyMode: z.enum(['local', 'cloud']).nullable(),
  consentAt: z.string().nullable(),
  outgoing: z.object({ manuscriptChars: z.number().int(), sourceChars: z.number().int(), passages: z.number().int(), requests: z.number().int() }).nullable(),
  usage: z.record(z.string(), z.number().nullable()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type EvidenceJob = z.infer<typeof EvidenceJobSchema>;
export const EvidenceJobResponse = z.object({ job: EvidenceJobSchema });
export const EvidenceJobListResponse = z.object({ jobs: z.array(EvidenceJobSchema) });

// ----------------------------------------------------------------- requests

export const ExtractScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), file: z.string().min(1).max(1024), startLine: z.number().int().min(1), startColumn: z.number().int().min(1), endLine: z.number().int().min(1), endColumn: z.number().int().min(1) }),
  z.object({ kind: z.literal('blocks'), blockIds: z.array(Id).min(1).max(500) }),
  z.object({ kind: z.literal('section'), sectionPath: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('manuscript') }),
]);

export const ExtractClaimsRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    scope: ExtractScopeSchema,
    /** `heuristic` needs no model; `model` uses the chosen model. */
    method: z.enum(['heuristic', 'model']).default('heuristic'),
    model: ModelChoiceSchema.optional(),
  })
  .strict();

export const ClaimsQuery = z.object({
  status: z.enum(CLAIM_STATUSES).optional(),
  reviewState: z.enum(CLAIM_REVIEW_STATES).optional(),
  section: z.string().max(1000).optional(),
  file: z.string().max(1024).optional(),
  includeArchived: z.enum(['0', '1']).optional(),
});

export const UpdateClaimRequest = z
  .object({
    claimText: z.string().trim().min(3).max(2000).optional(),
    claimType: z.string().regex(/^[a-z][a-z-]{1,40}$/).optional(),
    requiresEvidence: z.boolean().optional(),
    reviewState: z.enum(['proposed', 'approved', 'excluded']).optional(),
    exclusionReason: z.string().max(500).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    /** Mark the claim as reviewed by the researcher (shown as `user_reviewed`), or clear it. */
    userReviewed: z.boolean().optional(),
  })
  .strict();

export const SplitClaimRequest = z.object({ parts: z.array(z.string().trim().min(3).max(2000)).min(2).max(8) }).strict();
export const MergeClaimsRequest = z.object({ projectId: z.string().min(1).max(80), claimIds: z.array(Id).min(2).max(10) }).strict();

export const EvidenceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }),
  z.object({ kind: z.literal('collections'), collectionIds: z.array(Id).min(1).max(100) }),
  z.object({ kind: z.literal('papers'), libraryItemIds: z.array(Id).min(1).max(500) }),
]);

export const RetrieveEvidenceRequest = z
  .object({
    scope: EvidenceScopeSchema.default({ kind: 'library' }),
    limit: z.number().int().min(1).max(30).default(10),
    perPaper: z.number().int().min(1).max(5).default(2),
    abstracts: z.boolean().default(true),
    /** Also search connected scholarly sources (abstracts of papers outside the library). */
    external: z.boolean().default(false),
  })
  .strict();

export const AssessRequest = ModelChoiceSchema.extend({ force: z.boolean().default(false) }).strict();
export const AssessAllRequest = ModelChoiceSchema.extend({
  /** Retrieve first (with this scope) when the claim has no evidence yet. */
  retrieve: RetrieveEvidenceRequest.optional(),
  conflicts: z.boolean().default(true),
  /** A different model for conflict analysis. */
  conflictModel: ModelChoiceSchema.optional(),
  force: z.boolean().default(false),
}).strict();
export const RevalidateRequest = ModelChoiceSchema.partial({ providerId: true, model: true }).extend({ scope: EvidenceScopeSchema.default({ kind: 'library' }) }).strict();

export const ReviewEvidenceRequest = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    reclassifiedAs: z.enum(ASSESSMENTS).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict()
  .refine((r) => r.decision !== 'reclassify' || r.reclassifiedAs, { message: 'Choose the category to reclassify as' });

export const RecommendCitationsRequest = z.object({}).strict();
export const InsertCitationRequest = z
  .object({
    recommendationIds: z.array(Id).min(1).max(10),
    placement: z.enum(CITATION_PLACEMENTS).default('sentence-end'),
    command: z.enum(CITE_COMMANDS).optional(),
  })
  .strict();
export const RejectRecommendationRequest = z.object({ status: z.enum(['rejected', 'proposed']) }).strict();

export const WritingTargetSchema = z.object({
  projectId: z.string().min(1).max(80),
  file: z.string().min(1).max(1024),
  startLine: z.number().int().min(1),
  startColumn: z.number().int().min(1),
  endLine: z.number().int().min(1),
  endColumn: z.number().int().min(1),
  /** The selected text as the editor shows it; refused when the file on disk differs. */
  selectionText: z.string().max(40_000),
});

export const AnalyzeWritingRequest = WritingTargetSchema.extend({
  /** Model review operations to run in addition to the rules. */
  operations: z.array(z.enum(WRITING_OPERATIONS)).max(10).default([]),
  model: ModelChoiceSchema.optional(),
}).strict();
export const RewriteRequest = WritingTargetSchema.extend({
  operation: z.enum(WRITING_OPERATIONS),
  guidance: z.string().max(2000).nullable().default(null),
  model: ModelChoiceSchema,
}).strict();

export const ManuscriptReviewRequest = z
  .object({
    scope: z.enum(REVIEW_SCOPES).default('manuscript'),
    sectionPath: z.string().max(1000).optional(),
    claimIds: z.array(Id).max(500).optional(),
    introduction: z.boolean().default(false),
    conclusion: z.boolean().default(false),
    model: ModelChoiceSchema.optional(),
  })
  .strict();

export const EvidenceSettingsSchema = z.object({
  privacyMode: z.enum(EVIDENCE_PRIVACY_MODES),
  /** Providers allowed for cloud processing (empty: any configured provider, with consent). */
  allowedProviders: z.array(ProviderId).max(20),
  /** Model per task (used as the default choice in the UI). */
  models: z.record(z.enum(EVIDENCE_MODEL_TASKS), z.object({ providerId: ProviderId, model: ModelName }).nullable()),
});
export type EvidenceSettings = z.infer<typeof EvidenceSettingsSchema>;
export const UpdateEvidenceSettingsRequest = EvidenceSettingsSchema.partial().strict();
export const EvidenceSettingsResponse = z.object({ settings: EvidenceSettingsSchema });

export const CoverageRatioSchema = z.object({ numerator: z.number().int(), denominator: z.number().int(), value: z.number().nullable(), definition: z.string() });
export const CoverageSchema = z.object({
  totalClaims: z.number().int(),
  excluded: z.number().int(),
  noEvidenceNeeded: z.number().int(),
  assessable: z.number().int(),
  assessed: z.number().int(),
  notYetAssessed: z.number().int(),
  withSupportingEvidence: z.number().int(),
  withAcceptedSupport: z.number().int(),
  partiallySupported: z.number().int(),
  potentiallyContradicted: z.number().int(),
  insufficientEvidence: z.number().int(),
  contextualOnly: z.number().int(),
  needsRevalidation: z.number().int(),
  userReviewed: z.number().int(),
  ratios: z.object({ acceptedSupportCoverage: CoverageRatioSchema, assessedShare: CoverageRatioSchema }),
});
export const SectionSummarySchema = z.object({ sectionPath: z.string(), coverage: CoverageSchema, missingCitations: z.array(z.string()), conflicts: z.array(z.string()), sourceDiversity: z.object({ works: z.number().int(), links: z.number().int() }) });
export const CoverageResponse = z.object({ coverage: CoverageSchema, sections: z.array(SectionSummarySchema), revision: z.string() });

export const ManuscriptReviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  documentRevision: z.string(),
  reviewScope: z.enum(REVIEW_SCOPES),
  status: z.enum(EVIDENCE_JOB_STATUSES),
  coverage: CoverageSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  modelId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export const ManuscriptReviewResponse = z.object({ review: ManuscriptReviewSchema.nullable(), job: EvidenceJobSchema.nullable() });

export const WritingFindingSchema = z.object({
  operation: z.enum(WRITING_OPERATIONS),
  sentence: z.number().int().nullable(),
  excerpt: z.string(),
  message: z.string(),
  suggestion: z.string().nullable(),
  severity: z.enum(['info', 'suggestion', 'warning']),
  source: z.enum(['rule', 'model']),
});
export const AnalyzeWritingResponse = z.object({ sentences: z.array(z.string()), findings: z.array(WritingFindingSchema), job: EvidenceJobSchema.nullable() });
export const WritingSuggestionSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  originalText: z.string(),
  proposedText: z.string().nullable(),
  suggestionType: z.string(),
  explanation: z.string(),
  warnings: z.array(z.string()),
  meaningCheck: z.record(z.string(), z.unknown()).nullable(),
  proposalId: z.string().nullable(),
  status: z.enum(WRITING_SUGGESTION_STATUSES),
  modelId: z.string().nullable(),
  createdAt: z.string(),
});

export const InsertCitationResponse = z.object({
  proposalId: z.string(),
  command: z.enum(CITE_COMMANDS),
  keys: z.array(z.string()),
  edit: z.object({ file: z.string(), line: z.number().int(), before: z.string(), after: z.string(), mergedInto: z.string().nullable() }),
  warnings: z.array(z.string()),
  /** The `.bib` change to review and apply when an entry is missing (through the references API). */
  bib: z.object({ itemIds: z.array(z.string()), changeIds: z.array(z.string()), path: z.string(), baseHash: z.string().nullable(), original: z.string(), proposed: z.string() }).nullable(),
});

export const ManuscriptMarkersResponse = z.object({
  files: z.record(z.string(), z.array(z.object({ claimId: z.string(), fromLine: z.number().int(), toLine: z.number().int(), status: z.enum(CLAIM_STATUSES) }))),
});

export const ClaimParams = z.object({ claimId: Id });
export const RecordParams = z.object({ recordId: Id });
export const RecommendationParams = z.object({ recommendationId: Id });
export const EvidenceJobParams = z.object({ jobId: Id });
export const ProjectIdParams = z.object({ projectId: z.string().min(1).max(80) });

export type CitationRecommendationView = z.infer<typeof CitationRecommendationSchema>;
export type ConflictAnalysisView = z.infer<typeof ConflictSchema>;
export type WritingFindingView = z.infer<typeof WritingFindingSchema>;
export type CoverageView = z.infer<typeof CoverageSchema>;
export type CoverageRatio = z.infer<typeof CoverageRatioSchema>;
