/**
 * Evidence-linked writing (M5): constants and record shapes shared by the
 * database schema, the evidence packages, the API contracts and the web app.
 * (Replaces the unused placeholder types from M0.)
 */

// ------------------------------------------------------------------ claims

/** Built-in claim types. Stored as text so the set can grow. */
export const CLAIM_TYPES = [
  'empirical',
  'theoretical',
  'mathematical',
  'definition',
  'methodological',
  'historical',
  'comparative',
  'interpretive',
  'causal',
  'quantitative',
  'assumption',
  'hypothesis',
  'background',
] as const;
export type BuiltInClaimType = (typeof CLAIM_TYPES)[number];
export type ClaimType = BuiltInClaimType | (string & {});

/** Claim types that do not need an external source by default. */
export const NO_EVIDENCE_BY_DEFAULT: readonly BuiltInClaimType[] = ['definition', 'mathematical', 'assumption', 'hypothesis'];

export const ATOMICITY = ['atomic', 'compound', 'uncertain'] as const;
export type Atomicity = (typeof ATOMICITY)[number];

/** Aggregate status for filtering; individual assessments are always kept and shown. */
export const CLAIM_STATUSES = [
  'unchecked',
  'analyzing',
  'supporting_evidence_found',
  'partially_supported',
  'potentially_contradicted',
  'insufficient_evidence',
  'contextual_evidence_only',
  'not_assessable',
  'needs_revalidation',
  'user_reviewed',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Whether the researcher has approved the extracted claim. */
export const CLAIM_REVIEW_STATES = ['proposed', 'approved', 'excluded', 'archived'] as const;
export type ClaimReviewState = (typeof CLAIM_REVIEW_STATES)[number];

/** Sentences that are not scientific claims. */
export const NON_CLAIM_KINDS = ['question', 'instruction', 'heading', 'citation-only', 'equation-reference', 'transition', 'connective', 'structural'] as const;
export type NonClaimKind = (typeof NON_CLAIM_KINDS)[number];

export interface ClaimQuantity {
  value: string;
  unit?: string;
  context?: string;
}

export interface ScientificClaim {
  id: string;
  projectId: string;
  /** The manuscript (the project's root file). */
  documentId: string;
  sourceBlockId: string;
  sourceSentenceId?: string;
  /** The sentence the claim was extracted from, unchanged. */
  originalText: string;
  /** The claim itself (a span of the sentence, or a minimal paraphrase). */
  claimText: string;
  /** Character span of the claim in `originalText`, when the claim is a verbatim span. */
  span: { start: number; end: number } | null;
  normalizedText: string;
  claimType: ClaimType;
  atomicity: Atomicity;
  entities: string[];
  concepts: string[];
  quantities?: ClaimQuantity[];
  assumptions?: string[];
  documentRevision: string;
  textHash: string;
  status: ClaimStatus;
  reviewState: ClaimReviewState;
  /** False for definitions, identities and structural statements, or when the user excludes the claim. */
  requiresEvidence: boolean;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------- anchors

export const ANCHOR_STATUSES = ['current', 'modified', 'needs_revalidation', 'unmatched', 'deleted'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

export const MANUSCRIPT_BLOCK_KINDS = ['paragraph', 'heading', 'display-math', 'environment', 'list-item', 'caption', 'other'] as const;
export type ManuscriptBlockKind = (typeof MANUSCRIPT_BLOCK_KINDS)[number];

// ---------------------------------------------------------------- evidence

/** Where the evidence text comes from. Abstract-level evidence has no page. */
export const EVIDENCE_LEVELS = ['full_text', 'abstract', 'external_abstract'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const RETRIEVAL_METHODS = ['keyword', 'semantic', 'hybrid', 'abstract-match', 'external-search', 'manual'] as const;
export type RetrievalMethod = (typeof RETRIEVAL_METHODS)[number];

export const EVIDENCE_RECORD_STATUSES = ['active', 'excluded', 'source_changed', 'source_missing'] as const;
export type EvidenceRecordStatus = (typeof EVIDENCE_RECORD_STATUSES)[number];

/** Support categories. Relevance (ranks) is stored separately and never mixed in. */
export const ASSESSMENTS = ['direct_support', 'partial_support', 'indirect_support', 'context_only', 'contradiction', 'insufficient', 'irrelevant', 'not_assessed'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export const SUPPORTING_ASSESSMENTS: readonly Assessment[] = ['direct_support', 'partial_support'];

export const UNCERTAINTY = ['low', 'medium', 'high'] as const;
export type Uncertainty = (typeof UNCERTAINTY)[number];

/** State of an AI assessment row; history is never overwritten. */
export const ASSESSMENT_STATES = ['current', 'superseded', 'stale'] as const;
export type AssessmentState = (typeof ASSESSMENT_STATES)[number];

export const REVIEW_DECISIONS = ['accept', 'reject', 'reclassify', 'exclude_source', 'mark_reviewed', 'note'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const CONFLICT_CATEGORIES = [
  'direct_contradiction',
  'conditional_disagreement',
  'methodological_disagreement',
  'different_assumptions',
  'different_regimes',
  'different_definitions',
  'apparent_disagreement',
  'insufficient_information',
] as const;
export type ConflictCategory = (typeof CONFLICT_CATEGORIES)[number];

// --------------------------------------------------------------- citations

export const CITATION_RECOMMENDATION_STATUSES = ['proposed', 'accepted', 'rejected', 'inserted', 'superseded'] as const;
export type CitationRecommendationStatus = (typeof CITATION_RECOMMENDATION_STATUSES)[number];

export const CITATION_PLACEMENTS = ['sentence-end', 'clause-end', 'after-term'] as const;
export type CitationPlacement = (typeof CITATION_PLACEMENTS)[number];

// ----------------------------------------------------------------- writing

export const WRITING_OPERATIONS = [
  // Academic style
  'academic-tone',
  'concise',
  'formal',
  'readability',
  'remove-redundancy',
  'transitions',
  'reduce-ambiguity',
  // Scientific precision
  'overgeneralization',
  'qualify-claims',
  'terminology',
  'observation-vs-interpretation',
  'prediction-vs-result',
  'undefined-concepts',
  'causal-language',
  'terminology-consistency',
  // Technical writing
  'logical-flow',
  'paragraph-structure',
  'math-explanation',
  'clarify-assumptions',
  'equation-transitions',
  'figure-descriptions',
  'captions',
  'definitions',
  // Critical review
  'unsupported-statements',
  'needs-citations',
  'incomplete-explanations',
  'internal-contradictions',
  'duplicated-explanations',
  'unclear-reasoning',
] as const;
export type WritingOperation = (typeof WRITING_OPERATIONS)[number];

/** Operations that only report findings; the others propose rewritten text. */
export const REVIEW_ONLY_OPERATIONS: readonly WritingOperation[] = [
  'overgeneralization',
  'undefined-concepts',
  'terminology-consistency',
  'unsupported-statements',
  'needs-citations',
  'incomplete-explanations',
  'internal-contradictions',
  'duplicated-explanations',
  'unclear-reasoning',
];

export const WRITING_SUGGESTION_STATUSES = ['proposed', 'accepted', 'rejected', 'stale'] as const;
export type WritingSuggestionStatus = (typeof WRITING_SUGGESTION_STATUSES)[number];

// ------------------------------------------------------------------ review

export const REVIEW_SCOPES = ['manuscript', 'section', 'paragraphs', 'claims'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export const EVIDENCE_JOB_KINDS = ['extract', 'retrieve', 'assess', 'revalidate', 'review', 'rewrite', 'analyze'] as const;
export type EvidenceJobKind = (typeof EVIDENCE_JOB_KINDS)[number];

export const EVIDENCE_JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type EvidenceJobStatus = (typeof EVIDENCE_JOB_STATUSES)[number];

/** Model tasks that can be routed to different models. */
export const EVIDENCE_MODEL_TASKS = ['extraction', 'assessment', 'contradiction', 'writing', 'review'] as const;
export type EvidenceModelTask = (typeof EVIDENCE_MODEL_TASKS)[number];

/** Project privacy for M5 model calls. */
export const EVIDENCE_PRIVACY_MODES = ['local-only', 'cloud-allowed', 'confidential'] as const;
export type EvidencePrivacyMode = (typeof EVIDENCE_PRIVACY_MODES)[number];
