import type Database from 'better-sqlite3';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { offsetAt } from '@research-studio/ai-core';
import type {
  AnalyzeWritingRequest,
  AssessAllRequest,
  AssessRequest,
  ClaimView,
  ClaimsQuery,
  EvidenceRecordView,
  EvidenceSettings,
  ExtractClaimsRequest,
  InsertCitationRequest,
  ManuscriptReviewRequest,
  RetrieveEvidenceRequest,
  RevalidateRequest,
  ReviewEvidenceRequest,
  RewriteRequest,
  UpdateClaimRequest,
} from '@research-studio/api-contracts';
import { identityHash, sha256 } from '@research-studio/claim-anchors';
import { bibChangesFor, chooseCommand, citedKeys, detectCitationSetup, planCitationEdit, recommendCitations, resolveCitationKey, validateInsertion, type EvidenceForCitation } from '@research-studio/citation-intelligence';
import { schema, type Repositories, type StudioDb } from '@research-studio/database';
import {
  analyseConflict,
  ASSESSMENT_VERSION,
  assessSupport,
  checkSourceFreshness,
  citationReason,
  claimStatus,
  conflictPairs,
  countAssessments,
  extractClaimsHeuristic,
  extractClaimsWithModel,
  extractQuantities,
  extractTerms,
  guessClaimType,
  isEvidenceError,
  locate,
  locationText,
  mergeClaimTexts,
  normalizeClaimText,
  planRevalidation,
  PROMPT_VERSION,
  retrieveEvidence,
  snapshotHash,
  type AssessmentView,
  type ModelTarget,
  type PassageCandidate,
  type SentenceInput,
} from '@research-studio/evidence-engine';
import { NO_EVIDENCE_BY_DEFAULT, StudioError, type Assessment, type ClaimStatus } from '@research-studio/shared-types';
import { analyseParagraph, computeCoverage, isReviewOnly, reviewConclusion, reviewIntroduction, runWritingOperation, summariseSections, WRITING_PROMPT_VERSION, type ClaimForCoverage } from '@research-studio/writing-intelligence';
import type { EventBus } from '../events';
import { randomId } from '../security/tokens';
import type { ProposalService } from './ai/proposal-service';
import type { AiProviderService } from './ai/provider-service';
import type { AuditService } from './audit-service';
import type { DocumentRuntime } from './document-runtime';
import { EvidenceJobs, type JobContext } from './evidence/jobs';
import { lineAt, ManuscriptSync } from './evidence/manuscript-sync';
import { EvidencePrivacy, type Outgoing, type ResolvedModel } from './evidence/privacy';
import { LibrarySearchPort, sourceLookup } from './evidence/search-port';
import type { LibraryRuntime } from './library-runtime';
import type { LiteratureService } from './literature-service';
import type { Actor, ProjectService } from './project-service';

type ClaimRow = typeof schema.scientificClaims.$inferSelect;
type AnchorRow = typeof schema.claimAnchors.$inferSelect;
type SourceRow = typeof schema.evidenceSources.$inferSelect;
type RecordRow = typeof schema.evidenceRecords.$inferSelect;
type AssessmentRow = typeof schema.evidenceAssessments.$inferSelect;
type ReviewRow = typeof schema.evidenceReviews.$inferSelect;

const now = () => new Date().toISOString();
const ZERO_COUNTS = (): Record<Assessment, number> => ({ direct_support: 0, partial_support: 0, indirect_support: 0, context_only: 0, contradiction: 0, insufficient: 0, irrelevant: 0, not_assessed: 0 });

function rethrow(err: unknown): never {
  if (isEvidenceError(err)) {
    const code = err.code === 'invalid-output' || err.code === 'provider-error' ? 'PROVIDER_ERROR' : err.code === 'not-found' ? 'NOT_FOUND' : err.code === 'conflict' || err.code === 'cancelled' ? 'CONFLICT' : 'BAD_REQUEST';
    throw new StudioError(code, err.message, { reason: err.code.toUpperCase().replace(/-/g, '_') });
  }
  throw err;
}

/**
 * Evidence-linked writing (M5) in the runtime: manuscript structure and
 * claim anchors, claim extraction, retrieval of source passages through the
 * M3.3 index, model assessment and conflict analysis as persistent jobs,
 * human review kept apart, freshness and revalidation, citation
 * recommendation and reviewed insertion (as edit proposals), writing
 * analysis and rewrites (as edit proposals), and manuscript-wide coverage
 * and review. Every model call goes through the project's privacy settings
 * and per-operation consent.
 */
export class EvidenceRuntime {
  readonly sync: ManuscriptSync;
  readonly jobs: EvidenceJobs;
  readonly privacy: EvidencePrivacy;
  private readonly sqlite: Database.Database;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingSyncs = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: StudioDb,
    repos: Repositories,
    private readonly projects: ProjectService,
    private readonly documents: DocumentRuntime,
    private readonly library: LibraryRuntime,
    private readonly literature: LiteratureService | null,
    providers: AiProviderService,
    private readonly proposals: ProposalService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    log: FastifyBaseLogger,
  ) {
    this.sqlite = (db as unknown as { $client: Database.Database }).$client;
    this.sync = new ManuscriptSync(db, projects);
    this.jobs = new EvidenceJobs(db, events, log);
    this.privacy = new EvidencePrivacy(repos, providers, audit);
  }

  start(): void {
    this.jobs.recover();
    // Evidence follows the text: after a file changes, anchors are reconciled (claims with analysis only).
    this.unsubscribe = this.events.subscribe((e) => {
      if (e.type !== 'files.changed' || !e.paths.some((p) => /\.(tex|ltx)$/i.test(p))) return;
      if (!this.db.select({ id: schema.scientificClaims.id }).from(schema.scientificClaims).where(eq(schema.scientificClaims.projectId, e.projectId)).limit(1).get()) return;
      clearTimeout(this.timers.get(e.projectId));
      this.timers.set(
        e.projectId,
        setTimeout(() => {
          this.timers.delete(e.projectId);
          const p = this.resync(e.projectId).catch(() => undefined);
          this.pendingSyncs.add(p);
          void p.finally(() => this.pendingSyncs.delete(p));
        }, 300),
      );
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearTimeout(t);
    await this.jobs.stop();
    await Promise.allSettled([...this.pendingSyncs]);
  }

  /** Wait for background syncs and jobs (tests). */
  async idle(): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 350));
      if (!this.timers.size && !this.pendingSyncs.size) break;
      await Promise.allSettled([...this.pendingSyncs]);
    }
    await this.jobs.idle();
  }

  private async resync(projectId: string) {
    const r = await this.sync.sync(projectId);
    for (const id of r.changedClaimIds) this.refreshStatus(id);
    if (r.changedClaimIds.length) this.events.publish({ type: 'evidence.claims', projectId, claimIds: r.changedClaimIds });
    return r;
  }

  // ------------------------------------------------------------ lookups

  private claimRow(claimId: string): ClaimRow {
    const c = this.db.select().from(schema.scientificClaims).where(eq(schema.scientificClaims.id, claimId)).get();
    if (!c) throw new StudioError('NOT_FOUND', 'Claim not found');
    // The project must still exist (and is the authorisation boundary for everything below).
    this.projects.get(c.projectId);
    return c;
  }

  private anchor(claimId: string): AnchorRow {
    return this.db.select().from(schema.claimAnchors).where(eq(schema.claimAnchors.claimId, claimId)).get()!;
  }

  private records(claimId: string): RecordRow[] {
    return this.db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.claimId, claimId)).orderBy(schema.evidenceRecords.relevanceRank).all();
  }

  private recordRow(recordId: string): { record: RecordRow; claim: ClaimRow; source: SourceRow } {
    const record = this.db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.id, recordId)).get();
    if (!record) throw new StudioError('NOT_FOUND', 'Evidence not found');
    const claim = this.claimRow(record.claimId);
    const source = this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, record.sourceId)).get()!;
    return { record, claim, source };
  }

  /** The views the classifier works on: AI category, human decision, exclusion, staleness. */
  private assessmentViews(claimId: string): { views: AssessmentView[]; perRecord: Map<string, { current: AssessmentRow | null; history: AssessmentRow[]; reviews: ReviewRow[] }>; userReviewed: boolean } {
    const recs = this.records(claimId);
    const all = this.db.select().from(schema.evidenceAssessments).where(eq(schema.evidenceAssessments.claimId, claimId)).orderBy(desc(schema.evidenceAssessments.createdAt)).all();
    const reviews = this.db.select().from(schema.evidenceReviews).where(eq(schema.evidenceReviews.claimId, claimId)).orderBy(desc(schema.evidenceReviews.createdAt)).all();
    const perRecord = new Map<string, { current: AssessmentRow | null; history: AssessmentRow[]; reviews: ReviewRow[] }>();
    const views: AssessmentView[] = [];
    for (const r of recs) {
      const mine = all.filter((a) => a.evidenceRecordId === r.id);
      const current = mine.find((a) => a.status === 'current') ?? null;
      const stale = !current && mine.some((a) => a.status === 'stale');
      const rv = reviews.filter((x) => x.evidenceRecordId === r.id);
      perRecord.set(r.id, { current, history: mine.filter((a) => a !== current), reviews: rv });
      const latest = rv.find((x) => x.decision !== 'note');
      // A decision applies to the assessment it was made on; a newer assessment needs a new decision.
      const applies = latest && (!latest.assessmentId || latest.assessmentId === current?.id);
      const human = applies && latest.decision === 'reclassify' ? latest.reclassifiedAs : applies && latest.decision === 'accept' ? (current?.assessment ?? null) : null;
      const excluded = r.status === 'excluded' || (applies && latest.decision === 'reject') || false;
      if (current || stale || human) views.push({ recordId: r.id, ai: current?.assessment ?? null, human: human ?? null, excluded: !!excluded, stale: (stale && !human) || r.status === 'source_changed' || r.status === 'source_missing' });
    }
    const userReviewed = reviews.find((x) => x.evidenceRecordId === null && (x.decision === 'mark_reviewed' || x.decision === 'note'))?.decision === 'mark_reviewed';
    return { views, perRecord, userReviewed };
  }

  /** Recompute the aggregate status from the individual assessments (which stay visible). */
  private refreshStatus(claimId: string): ClaimStatus {
    const c = this.db.select().from(schema.scientificClaims).where(eq(schema.scientificClaims.id, claimId)).get();
    if (!c) return 'unchecked';
    const a = this.assessmentViews(claimId);
    const anchor = this.anchor(claimId);
    const needs = anchor?.mappingStatus === 'needs_revalidation' && c.status === 'needs_revalidation' && !a.views.some((v) => !v.stale && v.ai !== null);
    const status = claimStatus({ items: a.views, requiresEvidence: c.requiresEvidence && c.reviewState !== 'excluded', needsRevalidation: needs, userReviewed: a.userReviewed });
    if (status !== c.status) this.db.update(schema.scientificClaims).set({ status, updatedAt: now() }).where(eq(schema.scientificClaims.id, claimId)).run();
    return status;
  }

  // -------------------------------------------------------------- views

  private async fileContents(projectId: string, paths: Iterable<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const p of new Set(paths)) {
      try {
        out.set(p, (await this.projects.readFile(projectId, p)).content);
      } catch {
        // gone
      }
    }
    return out;
  }

  /** Where a claim's sentence is in its file, now. */
  private sentenceRange(content: string, anchor: AnchorRow, claim: ClaimRow): { start: number; end: number } | null {
    if (anchor.mappingStatus === 'deleted' || anchor.mappingStatus === 'unmatched' || anchor.startOffset === null || anchor.endOffset === null) return null;
    const block = content.slice(anchor.startOffset, anchor.endOffset);
    const at = locate(block, claim.originalText.trim());
    return at ? { start: anchor.startOffset + at.start, end: anchor.startOffset + at.end } : null;
  }

  private claimView(c: ClaimRow, anchor: AnchorRow, contents: Map<string, string>): ClaimView {
    const content = contents.get(anchor.filePath);
    const range = content ? this.sentenceRange(content, anchor, c) : null;
    const views = this.assessmentViews(c.id).views;
    return {
      id: c.id,
      projectId: c.projectId,
      documentId: c.documentId,
      sourceBlockId: c.documentBlockId,
      sourceSentenceId: c.sentenceId,
      originalText: c.originalText,
      claimText: c.claimText,
      span: c.spanStart !== null && c.spanEnd !== null ? { start: c.spanStart, end: c.spanEnd } : null,
      normalizedText: c.normalizedText,
      claimType: c.claimType,
      atomicity: c.atomicity,
      entities: c.entities,
      concepts: c.concepts,
      quantities: c.quantities,
      assumptions: c.assumptions,
      documentRevision: c.documentRevision,
      textHash: c.textHash,
      status: c.status,
      reviewState: c.reviewState,
      requiresEvidence: c.requiresEvidence,
      exclusionReason: c.exclusionReason,
      derivedFrom: c.derivedFrom,
      extractedBy: c.extractedBy,
      modelProvider: c.modelProvider,
      modelId: c.modelId,
      promptVersion: c.promptVersion,
      note: c.note,
      anchor: { filePath: anchor.filePath, sectionPath: anchor.sectionPath, mappingStatus: anchor.mappingStatus, previousText: anchor.previousText, lines: range && content ? { from: lineAt(content, range.start), to: lineAt(content, range.end) } : null },
      cited: citedKeys(c.originalText),
      counts: views.length ? countAssessments(views) : ZERO_COUNTS(),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private sourceView(s: SourceRow) {
    return {
      id: s.id,
      level: s.level,
      scholarlyWorkId: s.scholarlyWorkId,
      libraryItemId: s.libraryItemId,
      attachmentId: s.attachmentId,
      extractionId: s.extractionId,
      passageId: s.passageId,
      sourceSha256: s.sourceSha256,
      extractorVersion: s.extractorVersion,
      externalId: s.externalId,
      doi: s.doi,
      arxivId: s.arxivId,
      url: s.url,
      title: s.title,
      authors: s.authors,
      year: s.year,
      venue: s.venue,
      publicationType: s.publicationType,
      sectionPath: s.sectionPath,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      coordinates: s.coordinates,
      text: s.text,
      contextBefore: s.contextBefore,
      contextAfter: s.contextAfter,
      location: locationText(s),
      createdAt: s.createdAt,
    };
  }

  private assessmentView(a: AssessmentRow) {
    return {
      id: a.id,
      assessment: a.assessment,
      explanation: a.explanation,
      supportingText: a.supportingText,
      excerptVerified: a.excerptVerified,
      supportedSubclaims: a.supportedSubclaims,
      unsupportedSubclaims: a.unsupportedSubclaims,
      contradictoryStatements: a.contradictoryStatements,
      limitations: a.limitations,
      uncertainty: a.uncertainty,
      validationNotes: a.validationNotes,
      modelProvider: a.modelProvider,
      modelId: a.modelId,
      promptVersion: a.promptVersion,
      assessmentVersion: a.assessmentVersion,
      status: a.status,
      createdAt: a.createdAt,
      supersededAt: a.supersededAt,
    };
  }

  private evidenceViews(claimId: string): EvidenceRecordView[] {
    const recs = this.records(claimId);
    if (!recs.length) return [];
    const sources = new Map(this.db.select().from(schema.evidenceSources).where(inArray(schema.evidenceSources.id, recs.map((r) => r.sourceId))).all().map((s) => [s.id, s]));
    const { perRecord, views } = this.assessmentViews(claimId);
    const effectiveOf = new Map(views.map((v) => [v.recordId, v.excluded ? null : (v.human ?? v.ai)]));
    const firstOfWork = new Map<string, string>();
    return recs.map((r) => {
      const s = sources.get(r.sourceId)!;
      const work = s.scholarlyWorkId ?? s.externalId ?? s.title;
      const first = firstOfWork.get(work);
      if (!first) firstOfWork.set(work, r.id);
      const p = perRecord.get(r.id)!;
      return {
        id: r.id,
        claimId: r.claimId,
        status: r.status,
        retrievalMethod: r.retrievalMethod,
        queryVariant: r.queryVariant,
        relevanceRank: r.relevanceRank,
        keywordRank: r.keywordRank,
        semanticRank: r.semanticRank,
        fusedScore: r.fusedScore,
        retrievalIndexVersion: r.retrievalIndexVersion,
        retrievedAt: r.retrievedAt,
        source: this.sourceView(s),
        assessment: p.current ? this.assessmentView(p.current) : null,
        history: p.history.map((a) => this.assessmentView(a)),
        reviews: p.reviews.map((x) => ({ id: x.id, decision: x.decision, reclassifiedAs: x.reclassifiedAs, note: x.note, assessmentId: x.assessmentId, createdAt: x.createdAt })),
        effective: effectiveOf.get(r.id) ?? null,
        samePaperAs: first && first !== r.id ? first : null,
      };
    });
  }

  private conflictViews(claimId: string) {
    return this.db
      .select()
      .from(schema.conflictAnalyses)
      .where(eq(schema.conflictAnalyses.claimId, claimId))
      .orderBy(desc(schema.conflictAnalyses.createdAt))
      .all()
      .map((c) => ({ id: c.id, supportingRecordId: c.supportingRecordId, opposingRecordId: c.opposingRecordId, category: c.category, explanation: c.explanation, differences: c.differences, uncertainty: c.uncertainty, notes: [] as string[], modelId: c.modelId, status: c.status, createdAt: c.createdAt }));
  }

  // ------------------------------------------------------------- claims

  async listClaims(projectId: string, q: z.infer<typeof ClaimsQuery>) {
    this.projects.get(projectId);
    const synced = await this.resync(projectId);
    const rows = this.db
      .select({ claim: schema.scientificClaims, anchor: schema.claimAnchors })
      .from(schema.scientificClaims)
      .innerJoin(schema.claimAnchors, eq(schema.claimAnchors.claimId, schema.scientificClaims.id))
      .where(and(eq(schema.scientificClaims.projectId, projectId), q.includeArchived === '1' ? undefined : ne(schema.scientificClaims.reviewState, 'archived')))
      .all()
      .filter(({ claim, anchor }) => (!q.status || claim.status === q.status) && (!q.reviewState || claim.reviewState === q.reviewState) && (!q.section || anchor.sectionPath.startsWith(q.section)) && (!q.file || anchor.filePath === q.file));
    const contents = await this.fileContents(projectId, rows.map((r) => r.anchor.filePath));
    const order = new Map(synced.parsed.blocks.map((b) => [b.filePath + ':' + b.start, b.order]));
    const claims = rows
      .map(({ claim, anchor }) => ({ v: this.claimView(claim, anchor, contents), o: order.get(anchor.filePath + ':' + (anchor.startOffset ?? -1)) ?? 1e9, s: claim.spanStart ?? 0 }))
      .sort((a, b) => a.o - b.o || a.s - b.s)
      .map((x) => x.v);
    return { claims, manuscript: { rootFile: synced.parsed.rootFile, revision: synced.revision, files: synced.parsed.files, missingIncludes: synced.parsed.missingIncludes } };
  }

  async claimDetail(claimId: string) {
    const c = this.claimRow(claimId);
    const anchor = this.anchor(claimId);
    const contents = await this.fileContents(c.projectId, [anchor.filePath]);
    return { claim: this.claimView(c, anchor, contents), evidence: this.evidenceViews(claimId), conflicts: this.conflictViews(claimId), recommendations: this.recommendationViews(claimId) };
  }

  /** Sentences in an extraction scope, from the synced manuscript. */
  private async scopeSentences(input: z.infer<typeof ExtractClaimsRequest>): Promise<SentenceInput[]> {
    const synced = await this.resync(input.projectId);
    const blocks = this.db.select().from(schema.manuscriptBlocks).where(and(eq(schema.manuscriptBlocks.projectId, input.projectId), ne(schema.manuscriptBlocks.status, 'deleted'))).all();
    let chosen = blocks;
    const scope = input.scope;
    if (scope.kind === 'blocks') chosen = blocks.filter((b) => scope.blockIds.includes(b.id));
    else if (scope.kind === 'section') chosen = blocks.filter((b) => b.sectionPath === scope.sectionPath || b.sectionPath.startsWith(`${scope.sectionPath} > `));
    else if (scope.kind === 'selection') {
      const content = (await this.fileContents(input.projectId, [scope.file])).get(scope.file);
      if (content === undefined) throw new StudioError('NOT_FOUND', `${scope.file} was not found`);
      if (!synced.parsed.files.includes(scope.file)) throw new StudioError('BAD_REQUEST', `${scope.file} is not part of the manuscript (it is not the main file or included from it)`);
      const start = offsetAt(content, scope.startLine, scope.startColumn);
      const end = offsetAt(content, scope.endLine, scope.endColumn);
      chosen = blocks.filter((b) => b.filePath === scope.file && b.startOffset !== null && b.endOffset !== null && b.startOffset < Math.max(end, start + 1) && b.endOffset > start);
      // Only the sentences that overlap the selection.
      const sentences = this.db.select().from(schema.manuscriptSentences).where(inArray(schema.manuscriptSentences.blockId, chosen.map((b) => b.id))).all();
      const out: SentenceInput[] = [];
      for (const b of chosen.sort((x, y) => x.blockOrder - y.blockOrder)) {
        const raw = content.slice(b.startOffset!, b.endOffset!);
        for (const s of sentences.filter((x) => x.blockId === b.id).sort((x, y) => x.sentenceOrder - y.sentenceOrder)) {
          const at = locate(raw, s.text);
          const sStart = b.startOffset! + (at?.start ?? 0);
          const sEnd = b.startOffset! + (at?.end ?? raw.length);
          if (sStart < Math.max(end, start + 1) && sEnd > start) out.push({ sentenceId: s.id, blockId: b.id, text: s.text, sectionPath: b.sectionPath });
        }
      }
      return out;
    }
    const sentences = chosen.length ? this.db.select().from(schema.manuscriptSentences).where(inArray(schema.manuscriptSentences.blockId, chosen.map((b) => b.id))).all() : [];
    const order = new Map(chosen.map((b) => [b.id, b.blockOrder]));
    return sentences
      .sort((a, b) => (order.get(a.blockId)! - order.get(b.blockId)!) || a.sentenceOrder - b.sentenceOrder)
      .map((s) => ({ sentenceId: s.id, blockId: s.blockId, text: s.text, sectionPath: chosen.find((b) => b.id === s.blockId)!.sectionPath }));
  }

  private storeCandidates(projectId: string, revision: string, result: Awaited<ReturnType<typeof extractClaimsWithModel>>, model: ResolvedModel | null): string[] {
    const ids: string[] = [];
    const ts = now();
    this.db.transaction((tx) => {
      for (const c of result.claims) {
        const hash = identityHash(c.claimText);
        const dup = tx
          .select({ id: schema.scientificClaims.id })
          .from(schema.scientificClaims)
          .where(and(eq(schema.scientificClaims.projectId, projectId), eq(schema.scientificClaims.textHash, hash), eq(schema.scientificClaims.documentBlockId, c.blockId), ne(schema.scientificClaims.reviewState, 'archived')))
          .get();
        if (dup) continue;
        const block = tx.select().from(schema.manuscriptBlocks).where(eq(schema.manuscriptBlocks.id, c.blockId)).get()!;
        const id = `clm_${randomId(10)}`;
        tx.insert(schema.scientificClaims)
          .values({
            id,
            projectId,
            documentId: block.filePath,
            documentBlockId: c.blockId,
            sentenceId: c.sentenceId,
            originalText: c.originalText,
            claimText: c.claimText,
            spanStart: c.span?.start ?? null,
            spanEnd: c.span?.end ?? null,
            normalizedText: c.normalizedText,
            claimType: c.claimType,
            atomicity: c.atomicity,
            entities: c.entities,
            concepts: c.concepts,
            quantities: c.quantities,
            assumptions: c.assumptions,
            textHash: hash,
            documentRevision: revision,
            status: c.requiresEvidence ? 'unchecked' : 'not_assessable',
            reviewState: 'proposed',
            requiresEvidence: c.requiresEvidence,
            extractedBy: c.extractedBy,
            modelProvider: model?.providerId ?? null,
            modelId: model?.model ?? null,
            promptVersion: model ? PROMPT_VERSION : null,
            note: c.notes.join(' ') || null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
        tx.insert(schema.claimAnchors)
          .values({ id: `anc_${randomId(10)}`, claimId: id, projectId, filePath: block.filePath, blockId: block.id, sentenceId: c.sentenceId, sectionId: block.sectionId, sectionPath: block.sectionPath, parentBlockId: block.parentBlockId, textSnapshot: c.originalText, prefixContext: block.prefixContext, suffixContext: block.suffixContext, textHash: identityHash(c.originalText), revision, startOffset: block.startOffset, endOffset: block.endOffset, structurePath: block.structurePath, mappingStatus: 'current', updatedAt: ts })
          .run();
        ids.push(id);
      }
    });
    return ids;
  }

  /** Extract claims (heuristic: at once; model: as a job). The manuscript is never changed. */
  async extract(input: z.infer<typeof ExtractClaimsRequest>, actor: Actor) {
    this.projects.get(input.projectId);
    const sentences = await this.scopeSentences(input);
    const revision = (await this.sync.sync(input.projectId)).revision;
    if (!sentences.length) return { claims: [] as ClaimView[], nonClaims: [], rejected: [], job: null };
    if (input.method === 'heuristic') {
      const r = extractClaimsHeuristic(sentences);
      const ids = this.storeCandidates(input.projectId, revision, r, null);
      this.audit.record({ action: 'evidence.extract', outcome: 'success', actor: actor.sessionId, projectId: input.projectId, details: { method: 'heuristic', sentences: sentences.length, claims: ids.length } });
      this.events.publish({ type: 'evidence.claims', projectId: input.projectId, claimIds: ids });
      return { claims: await this.views(input.projectId, ids), nonClaims: r.nonClaims.map((n) => ({ ...n, text: sentences[n.sentenceIndex]!.text })), rejected: [], job: null };
    }
    if (!input.model) throw new StudioError('VALIDATION_FAILED', 'Choose a model for model-based extraction');
    const outgoing: Outgoing = { manuscriptChars: sentences.reduce((n, s) => n + s.text.length, 0), sourceChars: 0, passages: 0, requests: Math.ceil(sentences.length / 40), preview: { claims: sentences.slice(0, 5).map((s) => s.text.slice(0, 200)), passages: [] } };
    const model = await this.privacy.resolve(input.projectId, input.model, 'extraction', outgoing, actor);
    const job = this.jobs.start(input.projectId, 'extract', { key: 'extract', scope: input.scope }, model, async (ctx) => {
      const ids: string[] = [];
      const rejected: unknown[] = [];
      for (let i = 0; i < sentences.length; i += 40) {
        ctx.progress(i, sentences.length, 'Extracting claims');
        const batch = sentences.slice(i, i + 40);
        const r = await extractClaimsWithModel(this.target(model, ctx), batch).catch(rethrow);
        ctx.account({ manuscriptChars: batch.reduce((n, s) => n + s.text.length, 0), requests: 1 }, r.usage);
        ids.push(...this.storeCandidates(input.projectId, revision, r, model));
        rejected.push(...r.rejected.map((x) => ({ ...x, sentence: batch[x.sentenceIndex]?.text ?? null })));
      }
      this.audit.record({ action: 'evidence.extract', outcome: 'success', actor: actor.sessionId, projectId: input.projectId, details: { method: 'model', provider: model.providerId, model: model.model, privacyMode: model.privacyMode, claims: ids.length } });
      this.events.publish({ type: 'evidence.claims', projectId: input.projectId, claimIds: ids });
      return { claimIds: ids, rejected };
    });
    return { claims: [] as ClaimView[], nonClaims: [], rejected: [], job };
  }

  private async views(projectId: string, ids: string[]): Promise<ClaimView[]> {
    if (!ids.length) return [];
    const rows = this.db.select({ claim: schema.scientificClaims, anchor: schema.claimAnchors }).from(schema.scientificClaims).innerJoin(schema.claimAnchors, eq(schema.claimAnchors.claimId, schema.scientificClaims.id)).where(inArray(schema.scientificClaims.id, ids)).all();
    const contents = await this.fileContents(projectId, rows.map((r) => r.anchor.filePath));
    const byId = new Map(rows.map((r) => [r.claim.id, this.claimView(r.claim, r.anchor, contents)]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  private target(model: ResolvedModel, ctx: JobContext | { signal?: AbortSignal }): ModelTarget {
    return { provider: model.provider, model: model.model, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  }

  /** Edit, approve, exclude or annotate a claim. A material change to its text makes its assessments stale (kept as history). */
  async updateClaim(claimId: string, patch: z.infer<typeof UpdateClaimRequest>, actor: Actor) {
    const c = this.claimRow(claimId);
    const ts = now();
    const set: Partial<typeof schema.scientificClaims.$inferInsert> = { updatedAt: ts };
    let staled = 0;
    if (patch.claimText !== undefined && patch.claimText !== c.claimText) {
      const assessments = this.db.select({ id: schema.evidenceAssessments.id, claimTextHash: schema.evidenceAssessments.claimTextHash }).from(schema.evidenceAssessments).where(and(eq(schema.evidenceAssessments.claimId, claimId), eq(schema.evidenceAssessments.status, 'current'))).all();
      const plan = planRevalidation(c.claimText, patch.claimText, assessments);
      const span = locate(c.originalText, patch.claimText.replace(/[.;,]\s*$/, ''));
      Object.assign(set, { claimText: patch.claimText, normalizedText: normalizeClaimText(patch.claimText), textHash: identityHash(patch.claimText), spanStart: span?.start ?? null, spanEnd: span?.end ?? null, ...extractTerms(patch.claimText), quantities: extractQuantities(patch.claimText), extractedBy: 'manual' });
      if (plan.staleAssessmentIds.length) {
        this.db.update(schema.evidenceAssessments).set({ status: 'stale' }).where(inArray(schema.evidenceAssessments.id, plan.staleAssessmentIds)).run();
        staled = plan.staleAssessmentIds.length;
        set.status = 'needs_revalidation';
      }
    }
    if (patch.claimType !== undefined) set.claimType = patch.claimType;
    if (patch.requiresEvidence !== undefined) set.requiresEvidence = patch.requiresEvidence;
    if (patch.reviewState !== undefined) set.reviewState = patch.reviewState;
    if (patch.exclusionReason !== undefined) set.exclusionReason = patch.exclusionReason;
    if (patch.note !== undefined) set.note = patch.note;
    this.db.update(schema.scientificClaims).set(set).where(eq(schema.scientificClaims.id, claimId)).run();
    if (patch.userReviewed !== undefined) {
      this.db.insert(schema.evidenceReviews).values({ id: `erv_${randomId(10)}`, claimId, evidenceRecordId: null, decision: patch.userReviewed ? 'mark_reviewed' : 'note', note: patch.userReviewed ? null : 'Review mark removed', actor: actor.sessionId, createdAt: ts }).run();
    }
    if (staled === 0) this.refreshStatus(claimId);
    this.audit.record({ action: 'evidence.claim.update', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { fields: Object.keys(patch), staleAssessments: staled } });
    this.events.publish({ type: 'evidence.claims', projectId: c.projectId, claimIds: [claimId] });
    return { claim: (await this.views(c.projectId, [claimId]))[0]! };
  }

  /** Split a claim into parts (each found in the sentence where possible); the original is archived with its history. */
  async splitClaim(claimId: string, parts: string[], actor: Actor) {
    const c = this.claimRow(claimId);
    const anchor = this.anchor(claimId);
    const ts = now();
    const ids: string[] = [];
    this.db.transaction((tx) => {
      for (const text of parts) {
        const id = `clm_${randomId(10)}`;
        const span = locate(c.originalText, text.replace(/[.;,]\s*$/, ''));
        const type = guessClaimType(text);
        tx.insert(schema.scientificClaims)
          .values({ ...c, id, claimText: text, spanStart: span?.start ?? null, spanEnd: span?.end ?? null, normalizedText: normalizeClaimText(text), textHash: identityHash(text), claimType: type, atomicity: 'atomic', ...extractTerms(text), quantities: extractQuantities(text), status: 'unchecked', reviewState: 'proposed', requiresEvidence: !(NO_EVIDENCE_BY_DEFAULT as readonly string[]).includes(type), derivedFrom: [claimId], extractedBy: 'manual', createdAt: ts, updatedAt: ts })
          .run();
        tx.insert(schema.claimAnchors).values({ ...anchor, id: `anc_${randomId(10)}`, claimId: id, updatedAt: ts }).run();
        ids.push(id);
      }
      tx.update(schema.scientificClaims).set({ reviewState: 'archived', note: `Split into ${parts.length} claims`, updatedAt: ts }).where(eq(schema.scientificClaims.id, claimId)).run();
    });
    this.audit.record({ action: 'evidence.claim.split', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { parts: ids.length } });
    this.events.publish({ type: 'evidence.claims', projectId: c.projectId, claimIds: [claimId, ...ids] });
    return { claims: await this.views(c.projectId, ids) };
  }

  /** Merge claims of the same sentence or paragraph into one; the originals are archived. */
  async mergeClaims(projectId: string, claimIds: string[], actor: Actor) {
    const rows = claimIds.map((id) => this.claimRow(id));
    if (rows.some((r) => r.projectId !== projectId)) throw new StudioError('NOT_FOUND', 'Claim not found');
    if (new Set(rows.map((r) => r.documentBlockId)).size > 1) throw new StudioError('BAD_REQUEST', 'Only claims from the same paragraph can be merged');
    const first = rows[0]!;
    const text = mergeClaimTexts(rows.map((r) => r.claimText));
    const ts = now();
    const id = `clm_${randomId(10)}`;
    const anchor = this.anchor(first.id);
    this.db.transaction((tx) => {
      tx.insert(schema.scientificClaims)
        .values({ ...first, id, claimText: text, spanStart: null, spanEnd: null, normalizedText: normalizeClaimText(text), textHash: identityHash(text), atomicity: 'compound', ...extractTerms(text), status: 'unchecked', reviewState: 'proposed', derivedFrom: claimIds, extractedBy: 'manual', createdAt: ts, updatedAt: ts })
        .run();
      tx.insert(schema.claimAnchors).values({ ...anchor, id: `anc_${randomId(10)}`, claimId: id, updatedAt: ts }).run();
      tx.update(schema.scientificClaims).set({ reviewState: 'archived', note: 'Merged', updatedAt: ts }).where(inArray(schema.scientificClaims.id, claimIds)).run();
    });
    this.audit.record({ action: 'evidence.claim.merge', outcome: 'success', actor: actor.sessionId, projectId, target: id, details: { from: claimIds } });
    this.events.publish({ type: 'evidence.claims', projectId, claimIds: [...claimIds, id] });
    return { claim: (await this.views(projectId, [id]))[0]! };
  }

  // ---------------------------------------------------------- retrieval

  private port(scope: z.infer<typeof RetrieveEvidenceRequest>['scope']) {
    return new LibrarySearchPort(this.sqlite, this.documents, this.literature, scope);
  }

  /** Retrieve candidate passages for a claim from the library (no model involved). */
  async retrieve(claimId: string, req: z.infer<typeof RetrieveEvidenceRequest>, actor: Actor, signal?: AbortSignal) {
    const c = this.claimRow(claimId);
    const port = this.port(req.scope);
    const r = await retrieveEvidence({ claimText: c.claimText, entities: c.entities, concepts: c.concepts }, port, { limit: req.limit, perPaper: req.perPaper, abstracts: req.abstracts, external: req.external, ...(signal ? { signal } : {}) });
    const ts = now();
    const ids: string[] = [];
    for (const cand of r.candidates) {
      const ctx = cand.passageId ? await port.neighbours(cand.passageId) : { before: [], after: [] };
      ids.push(this.upsertRecord(c, cand, { rank: cand.rank, fused: cand.fusedScore, variants: cand.variants, index: r.indexVersion, ts, context: ctx }));
    }
    this.audit.record({ action: 'evidence.retrieve', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { found: ids.length, scope: req.scope.kind, external: req.external, semantic: r.semanticUsed } });
    this.events.publish({ type: 'evidence.claims', projectId: c.projectId, claimIds: [claimId] });
    return { evidence: this.evidenceViews(claimId), conflicts: this.conflictViews(claimId), warnings: r.warnings, queries: r.variants.map((v) => ({ variant: v.variant, query: v.query, mode: v.mode })) };
  }

  private upsertRecord(c: ClaimRow, cand: PassageCandidate, info: { rank: number; fused: number; variants: string[]; index: string; ts: string; context: { before: string[]; after: string[] } }): string {
    const snap = snapshotHash(cand);
    let source = this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.snapshotHash, snap)).get();
    if (!source) {
      const id = `esr_${randomId(10)}`;
      this.db
        .insert(schema.evidenceSources)
        .values({
          id,
          snapshotHash: snap,
          level: cand.level,
          scholarlyWorkId: cand.scholarlyWorkId && this.db.select({ id: schema.scholarlyWorks.id }).from(schema.scholarlyWorks).where(eq(schema.scholarlyWorks.id, cand.scholarlyWorkId)).get() ? cand.scholarlyWorkId : null,
          libraryItemId: cand.libraryItemId && this.db.select({ id: schema.libraryItems.id }).from(schema.libraryItems).where(eq(schema.libraryItems.id, cand.libraryItemId)).get() ? cand.libraryItemId : null,
          attachmentId: cand.attachmentId,
          extractionId: cand.extractionId,
          passageId: cand.passageId,
          stableKey: cand.stableKey,
          passageTextHash: cand.textHash,
          sourceSha256: cand.sourceSha256,
          extractorVersion: cand.extractorVersion,
          externalId: cand.externalId,
          doi: cand.paper.doi,
          arxivId: cand.paper.arxivId,
          url: cand.paper.url,
          title: cand.paper.title,
          authors: cand.paper.authors,
          year: cand.paper.year,
          venue: cand.paper.venue,
          publicationType: cand.paper.publicationType,
          sectionPath: cand.sectionPath,
          pageStart: cand.pageStart,
          pageEnd: cand.pageEnd,
          coordinates: cand.coordinates,
          text: cand.text,
          contextBefore: info.context.before.at(-1) ?? null,
          contextAfter: info.context.after[0] ?? null,
          createdAt: info.ts,
        })
        .run();
      source = this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, id)).get()!;
    }
    const existing = this.db.select().from(schema.evidenceRecords).where(and(eq(schema.evidenceRecords.claimId, c.id), eq(schema.evidenceRecords.sourceId, source.id))).get();
    const values = { retrievalMethod: cand.method, queryVariant: info.variants.join(','), relevanceRank: info.rank, keywordRank: cand.keywordRank, semanticRank: cand.semanticRank, fusedScore: info.fused, retrievalIndexVersion: info.index, claimTextHash: c.textHash, retrievedAt: info.ts };
    if (existing) {
      this.db.update(schema.evidenceRecords).set(values).where(eq(schema.evidenceRecords.id, existing.id)).run();
      return existing.id;
    }
    const id = `evr_${randomId(10)}`;
    this.db.insert(schema.evidenceRecords).values({ id, claimId: c.id, sourceId: source.id, status: 'active', ...values }).run();
    return id;
  }

  private candidateOf(s: SourceRow): PassageCandidate {
    return {
      level: s.level,
      passageId: s.passageId,
      extractionId: s.extractionId,
      attachmentId: s.attachmentId,
      libraryItemId: s.libraryItemId,
      scholarlyWorkId: s.scholarlyWorkId,
      externalId: s.externalId,
      text: s.text,
      textHash: s.passageTextHash,
      stableKey: s.stableKey,
      sectionPath: s.sectionPath,
      sectionType: null,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      coordinates: s.coordinates,
      sourceSha256: s.sourceSha256,
      extractorVersion: s.extractorVersion,
      paper: { title: s.title, authors: s.authors, year: s.year, venue: s.venue, doi: s.doi, arxivId: s.arxivId, publicationType: s.publicationType, url: s.url },
      method: 'manual',
      keywordRank: null,
      semanticRank: null,
      score: null,
    };
  }

  // --------------------------------------------------------- assessment

  private outgoingFor(c: ClaimRow, sources: SourceRow[]): Outgoing {
    return {
      manuscriptChars: (c.claimText.length + c.originalText.length) * Math.max(1, sources.length),
      sourceChars: sources.reduce((n, s) => n + s.text.length + (s.contextBefore?.length ?? 0) + (s.contextAfter?.length ?? 0), 0),
      passages: sources.length,
      requests: sources.length,
      preview: { claims: [c.claimText.slice(0, 300)], passages: sources.slice(0, 5).map((s) => ({ title: s.title, excerpt: s.text.slice(0, 200) })) },
    };
  }

  private async assessOne(c: ClaimRow, record: RecordRow, source: SourceRow, model: ResolvedModel, ctx: JobContext, jobId: string | null) {
    const out = await assessSupport(this.target(model, ctx), { claimText: c.claimText, claimType: c.claimType, originalText: c.originalText, sectionPath: this.anchor(c.id)?.sectionPath ?? '' }, this.candidateOf(source), { before: source.contextBefore ? [source.contextBefore] : [], after: source.contextAfter ? [source.contextAfter] : [] }).catch(rethrow);
    ctx.account({ manuscriptChars: out.sent.manuscriptChars, sourceChars: out.sent.sourceChars, passages: 1, requests: 1 }, out.usage);
    const ts = now();
    this.db.transaction((tx) => {
      tx.update(schema.evidenceAssessments).set({ status: 'superseded', supersededAt: ts }).where(and(eq(schema.evidenceAssessments.evidenceRecordId, record.id), inArray(schema.evidenceAssessments.status, ['current', 'stale']))).run();
      tx.insert(schema.evidenceAssessments)
        .values({
          id: `eas_${randomId(10)}`,
          claimId: c.id,
          evidenceRecordId: record.id,
          ...out.result,
          modelProvider: model.providerId,
          modelId: model.model,
          promptVersion: PROMPT_VERSION,
          assessmentVersion: ASSESSMENT_VERSION,
          claimTextHash: c.textHash,
          sourceSnapshotHash: source.snapshotHash,
          status: 'current',
          jobId,
          createdAt: ts,
        })
        .run();
    });
  }

  /** Assess one evidence record against its claim (a job). */
  async assessRecord(recordId: string, req: z.infer<typeof AssessRequest>, actor: Actor) {
    const { record, claim, source } = this.recordRow(recordId);
    const model = await this.privacy.resolve(claim.projectId, req, 'assessment', this.outgoingFor(claim, [source]), actor);
    const job = this.jobs.start(claim.projectId, 'assess', { key: `record:${recordId}`, recordId }, model, async (ctx) => {
      ctx.progress(0, 1, 'Assessing');
      await this.assessOne(claim, record, source, model, ctx, null);
      this.refreshStatus(claim.id);
      this.audit.record({ action: 'evidence.assess', outcome: 'success', actor: actor.sessionId, projectId: claim.projectId, target: recordId, details: { provider: model.providerId, model: model.model, privacyMode: model.privacyMode } });
      this.events.publish({ type: 'evidence.claims', projectId: claim.projectId, claimIds: [claim.id] });
      return { claimId: claim.id, recordIds: [recordId] };
    });
    return { job };
  }

  /** Retrieve (if needed), assess every candidate independently, then analyse supporting against opposing passages (a job). */
  async assessAll(claimId: string, req: z.infer<typeof AssessAllRequest>, actor: Actor) {
    const c = this.claimRow(claimId);
    if (this.jobs.running(c.projectId, 'assess', `claim:${claimId}`)) throw new StudioError('CONFLICT', 'This claim is already being assessed');
    let sources = this.records(claimId).filter((r) => r.status === 'active').map((r) => this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, r.sourceId)).get()!);
    if (!sources.length && req.retrieve) {
      await this.retrieve(claimId, req.retrieve, actor);
      sources = this.records(claimId).filter((r) => r.status === 'active').map((r) => this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, r.sourceId)).get()!);
    }
    if (!sources.length) throw new StudioError('CONFLICT', 'No evidence was retrieved for this claim yet', { reason: 'NO_EVIDENCE' });
    const model = await this.privacy.resolve(c.projectId, req, 'assessment', this.outgoingFor(c, sources), actor);
    const conflictModel = req.conflictModel ? await this.privacy.resolve(c.projectId, req.conflictModel, 'contradiction', this.outgoingFor(c, sources.slice(0, 2)), actor) : model;
    const job = this.jobs.start(c.projectId, 'assess', { key: `claim:${claimId}`, claimId }, model, async (ctx) => {
      const records = this.records(claimId).filter((r) => r.status === 'active');
      const { perRecord } = this.assessmentViews(claimId);
      const todo = records.filter((r) => req.force || !perRecord.get(r.id)?.current);
      for (const [i, r] of todo.entries()) {
        if (ctx.signal.aborted) break;
        ctx.progress(i, todo.length, 'Assessing passages');
        const source = this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, r.sourceId)).get()!;
        await this.assessOne(this.claimRow(claimId), r, source, model, ctx, null);
      }
      let conflicts = 0;
      if (req.conflicts && !ctx.signal.aborted) {
        const { views } = this.assessmentViews(claimId);
        const items = views.map((v) => ({ recordId: v.recordId, assessment: v.excluded ? null : (v.human ?? v.ai) }));
        const pairs = conflictPairs(items);
        if (pairs.length) this.db.update(schema.conflictAnalyses).set({ status: 'superseded' }).where(and(eq(schema.conflictAnalyses.claimId, claimId), eq(schema.conflictAnalyses.status, 'current'))).run();
        for (const [i, p] of pairs.entries()) {
          if (ctx.signal.aborted) break;
          ctx.progress(i, pairs.length, 'Comparing supporting and opposing passages');
          const src = (rid: string) => this.candidateOf(this.recordRow(rid).source);
          const out = await analyseConflict(this.target(conflictModel, ctx), c.claimText, { supporting: src(p.supporting.recordId), opposing: src(p.opposing.recordId) }).catch(rethrow);
          ctx.account({ manuscriptChars: c.claimText.length, sourceChars: src(p.supporting.recordId).text.length + src(p.opposing.recordId).text.length, passages: 2, requests: 1 }, out.usage);
          this.db
            .insert(schema.conflictAnalyses)
            .values({ id: `ecf_${randomId(10)}`, claimId, supportingRecordId: p.supporting.recordId, opposingRecordId: p.opposing.recordId, category: out.analysis.category, explanation: [out.analysis.explanation, ...out.notes].join(' '), differences: out.analysis.differences, uncertainty: out.analysis.uncertainty, modelProvider: conflictModel.providerId, modelId: conflictModel.model, promptVersion: PROMPT_VERSION, status: 'current', createdAt: now() })
            .run();
          conflicts++;
        }
      }
      const status = this.refreshStatus(claimId);
      this.audit.record({ action: 'evidence.assess', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { assessed: todo.length, conflicts, provider: model.providerId, model: model.model, privacyMode: model.privacyMode } });
      this.events.publish({ type: 'evidence.claims', projectId: c.projectId, claimIds: [claimId] });
      return { claimId, assessed: todo.length, conflicts, status };
    });
    return { job };
  }

  /** A researcher's decision on one piece of evidence (kept apart from the AI assessment). */
  async review(recordId: string, body: z.infer<typeof ReviewEvidenceRequest>, actor: Actor) {
    const { record, claim } = this.recordRow(recordId);
    const current = this.assessmentViews(claim.id).perRecord.get(recordId)?.current ?? null;
    this.db
      .insert(schema.evidenceReviews)
      .values({ id: `erv_${randomId(10)}`, claimId: claim.id, evidenceRecordId: recordId, assessmentId: current?.id ?? null, decision: body.decision, reclassifiedAs: body.reclassifiedAs ?? null, note: body.note ?? null, actor: actor.sessionId, createdAt: now() })
      .run();
    if (body.decision === 'exclude_source') this.db.update(schema.evidenceRecords).set({ status: 'excluded' }).where(eq(schema.evidenceRecords.id, record.id)).run();
    if (body.decision === 'mark_reviewed') this.db.insert(schema.evidenceReviews).values({ id: `erv_${randomId(10)}`, claimId: claim.id, evidenceRecordId: null, decision: 'mark_reviewed', actor: actor.sessionId, createdAt: now() }).run();
    this.refreshStatus(claim.id);
    this.audit.record({ action: 'evidence.review', outcome: 'success', actor: actor.sessionId, projectId: claim.projectId, target: recordId, details: { decision: body.decision, reclassifiedAs: body.reclassifiedAs ?? null } });
    this.events.publish({ type: 'evidence.claims', projectId: claim.projectId, claimIds: [claim.id] });
    return this.claimDetail(claim.id);
  }

  /** Check anchors and sources, re-retrieve, and assess what is stale (with a model) or report what needs it. */
  async revalidate(claimId: string, req: z.infer<typeof RevalidateRequest>, actor: Actor) {
    const c0 = this.claimRow(claimId);
    await this.resync(c0.projectId);
    const c = this.claimRow(claimId);
    const lookup = sourceLookup(this.sqlite);
    const changes: { recordId: string; state: string; reason?: string }[] = [];
    for (const r of this.records(claimId)) {
      const s = this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, r.sourceId)).get()!;
      const f = checkSourceFreshness(s, lookup);
      if (f.state === 'fresh') continue;
      changes.push({ recordId: r.id, state: f.state, reason: f.reason });
      if (f.state === 'moved') {
        // Same words in a new extraction: keep the old snapshot, link the new passage as its own source.
        this.db.update(schema.evidenceSources).set({ passageId: f.passageId }).where(eq(schema.evidenceSources.id, s.id)).run();
      } else {
        this.db.update(schema.evidenceRecords).set({ status: f.state }).where(eq(schema.evidenceRecords.id, r.id)).run();
        this.db.update(schema.evidenceAssessments).set({ status: 'stale' }).where(and(eq(schema.evidenceAssessments.evidenceRecordId, r.id), eq(schema.evidenceAssessments.status, 'current'))).run();
      }
    }
    // Assessments made against older claim text are stale (material changes only).
    const current = this.db.select().from(schema.evidenceAssessments).where(and(eq(schema.evidenceAssessments.claimId, claimId), eq(schema.evidenceAssessments.status, 'current'))).all();
    const prevText = this.anchor(claimId).previousText;
    if (prevText) {
      const plan = planRevalidation(prevText, c.originalText, current);
      if (plan.staleAssessmentIds.length) this.db.update(schema.evidenceAssessments).set({ status: 'stale' }).where(inArray(schema.evidenceAssessments.id, plan.staleAssessmentIds)).run();
    }
    await this.retrieve(claimId, { scope: req.scope, limit: 10, perPaper: 2, abstracts: true, external: false }, actor);
    // The anchor is current again; the earlier wording stays in previousText for comparison.
    this.db.update(schema.claimAnchors).set({ mappingStatus: 'current', updatedAt: now() }).where(eq(schema.claimAnchors.claimId, claimId)).run();
    this.audit.record({ action: 'evidence.revalidate', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { sourceChanges: changes.length } });
    if (req.providerId && req.model) {
      const { job } = await this.assessAll(claimId, { providerId: req.providerId, model: req.model, consent: req.consent ?? false, conflicts: true, force: false }, actor);
      return { sourceChanges: changes, job };
    }
    this.refreshStatus(claimId);
    return { sourceChanges: changes, job: null };
  }

  /** Reconcile the project's anchors with its files now. */
  async reconcileProject(projectId: string) {
    const r = await this.resync(projectId);
    return { revision: r.revision, summary: r.summary, changedClaimIds: r.changedClaimIds };
  }

  // ---------------------------------------------------------- citations

  private recommendationViews(claimId: string) {
    const rows = this.db.select().from(schema.citationRecommendations).where(eq(schema.citationRecommendations.claimId, claimId)).orderBy(desc(schema.citationRecommendations.createdAt)).all();
    return rows
      .filter((r) => r.status !== 'superseded')
      .map((r) => {
        const rec = r.evidenceRecordId ? this.db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.id, r.evidenceRecordId)).get() : null;
        const src = rec ? this.db.select().from(schema.evidenceSources).where(eq(schema.evidenceSources.id, rec.sourceId)).get() : null;
        const a = r.evidenceAssessmentId ? this.db.select().from(schema.evidenceAssessments).where(eq(schema.evidenceAssessments.id, r.evidenceAssessmentId)).get() : null;
        const meta = (r as { meta?: unknown }).meta as { problems?: string[]; warnings?: string[]; needsBibChange?: boolean } | undefined;
        return {
          id: r.id,
          claimId: r.claimId,
          libraryItemId: r.libraryItemId,
          scholarlyWorkId: r.scholarlyWorkId,
          citationKey: r.citationKey,
          keySource: r.keySource,
          recommendedPlacement: r.recommendedPlacement,
          evidenceRecordId: r.evidenceRecordId,
          evidenceAssessmentId: r.evidenceAssessmentId,
          reason: r.reason,
          status: r.status,
          proposalId: r.proposalId,
          paper: { title: src?.title ?? '', authors: src?.authors ?? [], year: src?.year ?? null, doi: src?.doi ?? null },
          passage: src ? { text: src.text, location: locationText(src) } : null,
          assessment: a?.assessment ?? null,
          problems: meta?.problems ?? [],
          warnings: meta?.warnings ?? [],
          needsBibChange: r.keySource === 'library',
          createdAt: r.createdAt,
        };
      });
  }

  /** Recommend citations from accepted or verified supporting evidence (one per paper), with key checks. */
  async recommend(claimId: string, actor: Actor) {
    const c = this.claimRow(claimId);
    const evidence = this.evidenceViews(claimId);
    const items: EvidenceForCitation[] = evidence
      .filter((e) => e.effective)
      .map((e) => ({
        recordId: e.id,
        assessmentId: e.assessment?.id ?? null,
        scholarlyWorkId: e.source.scholarlyWorkId,
        libraryItemId: e.source.libraryItemId,
        assessment: e.effective!,
        accepted: e.reviews[0]?.decision === 'accept' || e.reviews[0]?.decision === 'reclassify',
        rejected: e.reviews[0]?.decision === 'reject' || e.status === 'excluded',
        stale: e.status === 'source_changed' || e.status === 'source_missing',
        excerptVerified: e.assessment?.excerptVerified ?? false,
        uncertainty: e.assessment?.uncertainty ?? 'high',
        level: e.source.level,
      }));
    const refs = this.library.projectReferences(actor);
    const cited = new Set(citedKeys(c.originalText).map((k) => this.library.repo.getItemByCitationKey(k)?.id).filter((x): x is string => !!x));
    const { candidates } = recommendCitations(items, cited);
    const linked = new Set(this.library.repo.projectItemIds(c.projectId));
    const linkedCandidates = candidates.filter((x) => linked.has(x.libraryItemId)).map((x) => x.libraryItemId);
    const preview = linkedCandidates.length ? await refs.preview(c.projectId, { itemIds: linkedCandidates }) : null;
    const bibKeys = new Set((await refs.references(c.projectId)).citations.filter((x) => x.definedIn.length).map((x) => x.key.toLowerCase()));
    const ts = now();
    this.db.update(schema.citationRecommendations).set({ status: 'superseded', updatedAt: ts }).where(and(eq(schema.citationRecommendations.claimId, claimId), eq(schema.citationRecommendations.status, 'proposed'))).run();
    for (const cand of candidates) {
      const item = this.library.repo.getItems([cand.libraryItemId])[0];
      if (!item) continue;
      const known = linked.has(item.id) ? (preview?.changes ?? []) : [];
      const resolved = resolveCitationKey({ id: item.id, citationKey: item.citationKey }, known);
      // Not attached to the project yet: the library key, with a .bib entry to add unless the file already defines it.
      const key = linked.has(item.id) ? resolved : { ...resolved, needsBibChange: !!item.citationKey && !bibKeys.has(item.citationKey.toLowerCase()) };
      if (!key.key) continue;
      const src = evidence.find((e) => e.id === cand.best.recordId)!.source;
      this.db
        .insert(schema.citationRecommendations)
        .values({
          id: `ecr_${randomId(10)}`,
          claimId,
          scholarlyWorkId: cand.scholarlyWorkId && this.db.select({ id: schema.scholarlyWorks.id }).from(schema.scholarlyWorks).where(eq(schema.scholarlyWorks.id, cand.scholarlyWorkId)).get() ? cand.scholarlyWorkId : null,
          libraryItemId: cand.libraryItemId,
          citationKey: key.key,
          keySource: key.collision ? 'collision' : key.needsBibChange ? 'library' : key.source,
          recommendedPlacement: c.atomicity === 'atomic' && c.spanStart !== null && c.spanEnd !== null && c.spanEnd < c.originalText.trim().length - 1 ? 'clause-end' : 'sentence-end',
          evidenceAssessmentId: cand.best.assessmentId,
          evidenceRecordId: cand.best.recordId,
          reason: citationReason({ assessment: cand.best.assessment, reviewed: cand.best.accepted, level: src.level, pageStart: src.pageStart, pageEnd: src.pageEnd, sectionPath: src.sectionPath, explanation: evidence.find((e) => e.id === cand.best.recordId)!.assessment?.explanation ?? '' }),
          status: key.collision ? 'rejected' : 'proposed',
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    this.audit.record({ action: 'evidence.citations.recommend', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { recommended: candidates.length } });
    return { recommendations: this.recommendationViews(claimId) };
  }

  setRecommendationStatus(recommendationId: string, status: 'rejected' | 'proposed', actor: Actor) {
    const r = this.db.select().from(schema.citationRecommendations).where(eq(schema.citationRecommendations.id, recommendationId)).get();
    if (!r) throw new StudioError('NOT_FOUND', 'Recommendation not found');
    const c = this.claimRow(r.claimId);
    this.db.update(schema.citationRecommendations).set({ status, updatedAt: now() }).where(eq(schema.citationRecommendations.id, recommendationId)).run();
    this.audit.record({ action: 'evidence.citations.status', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: recommendationId, details: { status } });
    return { recommendations: this.recommendationViews(r.claimId) };
  }

  /** Prepare a citation as a reviewed edit proposal (and the `.bib` change to review when an entry is missing). Nothing is written here. */
  async insertCitations(claimId: string, req: z.infer<typeof InsertCitationRequest>, actor: Actor) {
    const c0 = this.claimRow(claimId);
    await this.resync(c0.projectId);
    const c = this.claimRow(claimId);
    const anchor = this.anchor(claimId);
    const recs = this.db.select().from(schema.citationRecommendations).where(inArray(schema.citationRecommendations.id, req.recommendationIds)).all();
    if (recs.length !== req.recommendationIds.length || recs.some((r) => r.claimId !== claimId)) throw new StudioError('NOT_FOUND', 'Recommendation not found');
    if (recs.some((r) => r.status !== 'proposed' && r.status !== 'accepted')) throw new StudioError('CONFLICT', 'Only open recommendations can be inserted');
    const project = this.projects.get(c.projectId);
    const file = await this.projects.readFile(c.projectId, anchor.filePath);
    const range = this.sentenceRange(file.content, anchor, c);
    if (!range) throw new StudioError('CONFLICT', 'The claim’s sentence is no longer in the text; reconcile or revalidate the claim first', { reason: 'ANCHOR_LOST' });
    const refs = this.library.projectReferences(actor);
    const itemIds = recs.map((r) => r.libraryItemId).filter((x): x is string => !!x);
    // Citing a paper attaches it to the project (as adding it from the references panel does).
    const linkedNow = new Set(this.library.repo.projectItemIds(c.projectId));
    const toLink = itemIds.filter((id) => !linkedNow.has(id));
    if (toLink.length) {
      refs.link(c.projectId, toLink);
      this.audit.record({ action: 'evidence.citations.link', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, details: { itemIds: toLink } });
    }
    const preview = await refs.preview(c.projectId, { itemIds });
    const warnings: string[] = [];
    const keys: string[] = [];
    const already = citedKeys(file.content.slice(range.start, range.end));
    for (const r of recs) {
      const item = r.libraryItemId ? this.library.repo.getItems([r.libraryItemId])[0] : null;
      const key = resolveCitationKey({ id: r.libraryItemId ?? '', citationKey: item?.citationKey ?? null }, preview.changes);
      const check = validateInsertion({
        inLibrary: !!item,
        key: key.key ?? r.citationKey,
        keyValid: key.key ? null : (key.problems[0] ?? 'missing key'),
        collision: key.collision,
        alreadyCited: already.some((k) => k.toLowerCase() === (key.key ?? '').toLowerCase()),
        bibEntryExists: !key.needsBibChange,
        bibChangePlanned: key.needsBibChange,
      });
      if (!check.ok) throw new StudioError('CONFLICT', check.problems.join(' '), { reason: 'CITATION_INVALID', problems: check.problems });
      warnings.push(...check.warnings);
      keys.push(key.key!);
    }
    const main = project.mainFile === anchor.filePath ? file.content : ((await this.fileContents(c.projectId, [project.mainFile])).get(project.mainFile) ?? '');
    const setup = detectCitationSetup(main.split(/\\begin\s*\{document\}/)[0] ?? '');
    const settings = await refs.settings(c.projectId);
    const chosen = chooseCommand(req.command ?? settings.citeCommand, setup);
    if (chosen.warning) warnings.push(chosen.warning);
    const claimRange = req.placement === 'clause-end' && c.spanStart !== null && c.spanEnd !== null ? (() => {
      const at = locate(file.content.slice(range.start, range.end), c.claimText.replace(/[.;,]\s*$/, ''));
      if (!at) return null;
      // Include the punctuation that ends the clause.
      const end = range.start + at.end;
      const punct = /^[,;:]/.exec(file.content.slice(end));
      return { start: range.start + at.start, end: end + (punct ? 1 : 0) };
    })() : null;
    if (req.placement === 'clause-end' && !claimRange) warnings.push('The clause could not be located; the citation goes at the end of the sentence.');
    const edit = planCitationEdit({ content: file.content, sentence: range, claim: claimRange, keys, command: chosen.command, placement: claimRange ? 'clause-end' : 'sentence-end' });
    if (edit.skippedKeys.length === keys.length) throw new StudioError('CONFLICT', 'The sentence already cites these sources', { reason: 'ALREADY_CITED' });
    const proposal = this.proposals.create(
      c.projectId,
      { conversationId: null, messageId: null, agentRunId: null, source: 'model', action: null },
      {
        file: anchor.filePath,
        changeType: 'modify',
        baseHash: file.hash,
        original: edit.original,
        proposed: edit.replacement,
        range: { start: edit.start, end: edit.end },
        explanation: `Cite ${keys.join(', ')} for: “${c.claimText.slice(0, 160)}”. ${recs.map((r) => r.reason).join(' ')}`.slice(0, 2000),
        warnings: warnings.map((w) => ({ code: 'citation', message: w })),
      },
      null,
    );
    const needs = recs.filter((r) => resolveCitationKey({ id: r.libraryItemId ?? '', citationKey: this.library.repo.getItems([r.libraryItemId ?? ''])[0]?.citationKey ?? null }, preview.changes).needsBibChange).map((r) => r.libraryItemId!);
    let bib = null;
    if (needs.length) {
      const sel = bibChangesFor(needs, preview.changes as never);
      const chosenPreview = await refs.preview(c.projectId, { itemIds: needs, changeIds: sel.changeIds });
      bib = { itemIds: needs, changeIds: sel.changeIds, path: chosenPreview.path, baseHash: chosenPreview.baseHash, original: chosenPreview.original, proposed: chosenPreview.proposed };
    }
    this.db.update(schema.citationRecommendations).set({ status: 'accepted', proposalId: proposal.id, updatedAt: now() }).where(inArray(schema.citationRecommendations.id, req.recommendationIds)).run();
    this.audit.record({ action: 'evidence.citations.propose', outcome: 'success', actor: actor.sessionId, projectId: c.projectId, target: claimId, details: { keys, command: chosen.command, proposalId: proposal.id, bibChange: !!bib } });
    return { proposalId: proposal.id, command: chosen.command, keys, edit: { file: anchor.filePath, line: lineAt(file.content, range.start), before: edit.before, after: edit.after, mergedInto: edit.mergedInto }, warnings, bib };
  }

  // ------------------------------------------------------------ writing

  private async selection(t: z.infer<typeof AnalyzeWritingRequest> | z.infer<typeof RewriteRequest>) {
    this.projects.get(t.projectId);
    const file = await this.projects.readFile(t.projectId, t.file);
    const start = offsetAt(file.content, t.startLine, t.startColumn);
    const end = offsetAt(file.content, t.endLine, t.endColumn);
    if (end <= start) throw new StudioError('VALIDATION_FAILED', 'Select some text first');
    const text = file.content.slice(start, end);
    if (text.replace(/\r\n/g, '\n') !== t.selectionText.replace(/\r\n/g, '\n')) throw new StudioError('STALE_PROPOSAL', 'The selection no longer matches the saved file. Save the file and select the text again.');
    return { file, start, end, text };
  }

  private claimsInRange(projectId: string, filePath: string, content: string, start: number, end: number): ClaimRow[] {
    const rows = this.db.select({ claim: schema.scientificClaims, anchor: schema.claimAnchors }).from(schema.scientificClaims).innerJoin(schema.claimAnchors, eq(schema.claimAnchors.claimId, schema.scientificClaims.id)).where(and(eq(schema.scientificClaims.projectId, projectId), eq(schema.claimAnchors.filePath, filePath), ne(schema.scientificClaims.reviewState, 'archived'))).all();
    return rows.filter(({ claim, anchor }) => {
      const r = this.sentenceRange(content, anchor, claim);
      return r && r.start < end && r.end > start;
    }).map((r) => r.claim);
  }

  /** Writing analysis: rules at once; model review operations as a job. */
  async analyzeWriting(req: z.infer<typeof AnalyzeWritingRequest>, actor: Actor) {
    const sel = await this.selection(req);
    const claims = this.claimsInRange(req.projectId, req.file, sel.file.content, sel.start, sel.end);
    const analysis = analyseParagraph(sel.text);
    const needs = new Set<number>();
    analysis.sentences.forEach((s, i) => {
      if (claims.some((c) => c.requiresEvidence && c.originalText.trim() === s.trim()) && !citedKeys(s).length) needs.add(i);
    });
    const findings = analyseParagraph(sel.text, { needsEvidence: needs }).findings;
    let job = null;
    if (req.operations.length) {
      if (!req.model) throw new StudioError('VALIDATION_FAILED', 'Choose a model for the review operations');
      const model = await this.privacy.resolve(req.projectId, req.model, 'writing', { manuscriptChars: sel.text.length * req.operations.length, sourceChars: 0, passages: 0, requests: req.operations.length, preview: { claims: [sel.text.slice(0, 300)], passages: [] } }, actor);
      job = this.jobs.start(req.projectId, 'analyze', { key: `analyze:${randomId(6)}`, file: req.file }, model, async (ctx) => {
        const out: unknown[] = [];
        for (const [i, op] of req.operations.entries()) {
          ctx.progress(i, req.operations.length, `Reviewing: ${op}`);
          const r = await runWritingOperation(this.target(model, ctx), { operation: op, text: sel.text }).catch(rethrow);
          ctx.account({ manuscriptChars: sel.text.length, requests: 1 }, r.usage);
          if (r.kind === 'findings') out.push(...r.findings);
        }
        this.db.insert(schema.writingSuggestions).values({ id: `ews_${randomId(10)}`, projectId: req.projectId, filePath: req.file, originalText: sel.text, suggestionType: 'review', explanation: `${out.length} findings`, findings: out as Record<string, unknown>[], modelProvider: model.providerId, modelId: model.model, promptVersion: WRITING_PROMPT_VERSION, status: 'proposed', createdAt: now() }).run();
        return { findings: out };
      });
    }
    this.audit.record({ action: 'evidence.writing.analyze', outcome: 'success', actor: actor.sessionId, projectId: req.projectId, target: req.file, details: { findings: findings.length, operations: req.operations } });
    return { sentences: analysis.sentences, findings, job };
  }

  /** A rewrite as a job; an acceptable result becomes an edit proposal to review (never applied here). */
  async rewrite(req: z.infer<typeof RewriteRequest>, actor: Actor) {
    const sel = await this.selection(req);
    const blocks = this.db.select().from(schema.manuscriptBlocks).where(and(eq(schema.manuscriptBlocks.projectId, req.projectId), eq(schema.manuscriptBlocks.filePath, req.file), ne(schema.manuscriptBlocks.status, 'deleted'))).all().sort((a, b) => a.blockOrder - b.blockOrder);
    const before = blocks.filter((b) => (b.endOffset ?? 0) <= sel.start).at(-1)?.text ?? '';
    const after = blocks.find((b) => (b.startOffset ?? 0) >= sel.end)?.text ?? '';
    const model = await this.privacy.resolve(req.projectId, req.model, 'writing', { manuscriptChars: sel.text.length + before.length + after.length, sourceChars: 0, passages: 0, requests: 1, preview: { claims: [sel.text.slice(0, 300)], passages: [] } }, actor);
    const claims = this.claimsInRange(req.projectId, req.file, sel.file.content, sel.start, sel.end);
    const job = this.jobs.start(req.projectId, isReviewOnly(req.operation) ? 'analyze' : 'rewrite', { key: `rewrite:${randomId(6)}`, file: req.file, operation: req.operation }, model, async (ctx) => {
      ctx.progress(0, 1, 'Writing');
      const r = await runWritingOperation(this.target(model, ctx), { operation: req.operation, text: sel.text, context: { before, after }, guidance: req.guidance }).catch(rethrow);
      ctx.account({ manuscriptChars: sel.text.length + before.length + after.length, requests: 1 }, r.usage);
      const id = `ews_${randomId(10)}`;
      if (r.kind === 'findings') {
        this.db.insert(schema.writingSuggestions).values({ id, projectId: req.projectId, filePath: req.file, originalText: sel.text, suggestionType: req.operation, explanation: `${r.findings.length} findings`, findings: r.findings as unknown as Record<string, unknown>[], modelProvider: model.providerId, modelId: model.model, promptVersion: WRITING_PROMPT_VERSION, status: 'proposed', createdAt: now() }).run();
        return { suggestionId: id, findings: r.findings, proposalId: null };
      }
      let proposalId: string | null = null;
      const warnings = [...r.validation.warnings, ...r.answer.warnings];
      if (r.validation.offerable) {
        const p = this.proposals.create(
          req.projectId,
          { conversationId: null, messageId: null, agentRunId: null, source: 'model', action: null },
          { file: req.file, changeType: 'modify', baseHash: sel.file.hash, original: sel.text, proposed: r.answer.proposedText, range: { start: sel.start, end: sel.end }, explanation: `${req.operation}: ${r.answer.explanation}`.slice(0, 2000), warnings: warnings.map((w) => ({ code: 'writing', message: w })) },
          null,
        );
        proposalId = p.id;
      }
      this.db
        .insert(schema.writingSuggestions)
        .values({ id, projectId: req.projectId, filePath: req.file, originalText: sel.text, proposedText: r.answer.proposedText, suggestionType: req.operation, explanation: r.answer.explanation, warnings, meaningCheck: { ...r.validation.meaning, preservation: r.validation.preservation, modelSaysChanged: r.answer.meaningChanged }, proposalId, modelProvider: model.providerId, modelId: model.model, promptVersion: WRITING_PROMPT_VERSION, status: r.validation.offerable ? 'proposed' : 'rejected', createdAt: now() })
        .run();
      this.audit.record({ action: 'evidence.writing.rewrite', outcome: 'success', actor: actor.sessionId, projectId: req.projectId, target: req.file, details: { operation: req.operation, offerable: r.validation.offerable, proposalId, provider: model.providerId, model: model.model } });
      return { suggestionId: id, proposalId, offerable: r.validation.offerable, warnings, meaning: r.validation.meaning, affectedClaimIds: claims.map((c) => c.id) };
    });
    return { job };
  }

  writingSuggestion(projectId: string, id: string) {
    const r = this.db.select().from(schema.writingSuggestions).where(and(eq(schema.writingSuggestions.id, id), eq(schema.writingSuggestions.projectId, projectId))).get();
    if (!r) throw new StudioError('NOT_FOUND', 'Suggestion not found');
    return { suggestion: { id: r.id, filePath: r.filePath, originalText: r.originalText, proposedText: r.proposedText, suggestionType: r.suggestionType, explanation: r.explanation, warnings: r.warnings, meaningCheck: r.meaningCheck ?? null, proposalId: r.proposalId, status: r.status, modelId: r.modelId, createdAt: r.createdAt }, findings: r.findings };
  }

  // ------------------------------------------------------------- review

  private coverageClaims(projectId: string): (ClaimForCoverage & { cited: boolean; claimText: string })[] {
    const rows = this.db.select({ claim: schema.scientificClaims, anchor: schema.claimAnchors }).from(schema.scientificClaims).innerJoin(schema.claimAnchors, eq(schema.claimAnchors.claimId, schema.scientificClaims.id)).where(eq(schema.scientificClaims.projectId, projectId)).all();
    return rows.map(({ claim, anchor }) => {
      const ev = this.evidenceViews(claim.id);
      const { views } = this.assessmentViews(claim.id);
      const live = views.filter((v) => !v.stale && !v.excluded);
      const accepted = ev.filter((e) => (e.effective === 'direct_support' || e.effective === 'partial_support') && (e.reviews[0]?.decision === 'accept' || e.reviews[0]?.decision === 'reclassify'));
      const model = ev.filter((e) => e.effective === 'direct_support' && e.assessment?.excerptVerified);
      return {
        id: claim.id,
        claimText: claim.claimText,
        sectionPath: anchor.sectionPath,
        status: claim.status,
        reviewState: claim.reviewState,
        requiresEvidence: claim.requiresEvidence,
        assessed: live.some((v) => (v.human ?? v.ai) && (v.human ?? v.ai) !== 'not_assessed'),
        acceptedSupport: accepted.length > 0,
        modelSupport: model.length > 0,
        supportingWorkIds: [...new Set([...accepted, ...model].map((e) => e.source.scholarlyWorkId ?? e.source.title))],
        cited: citedKeys(claim.originalText).length > 0,
      };
    });
  }

  async coverage(projectId: string) {
    this.projects.get(projectId);
    const r = await this.resync(projectId);
    const claims = this.coverageClaims(projectId);
    return { coverage: computeCoverage(claims), sections: summariseSections(claims), revision: r.revision };
  }

  /** Manuscript-wide review: coverage, sections, rule findings, and optional model reviews of introduction and conclusion (a job). */
  async startReview(projectId: string, req: z.infer<typeof ManuscriptReviewRequest>, actor: Actor) {
    this.projects.get(projectId);
    const synced = await this.resync(projectId);
    const blocks = synced.parsed.blocks;
    const intro = blocks.filter((b) => /introduction|background/i.test(b.sectionPath.split(' > ')[0] ?? ''));
    const concl = blocks.filter((b) => /conclusion|summary|outlook|discussion/i.test(b.sectionPath.split(' > ')[0] ?? ''));
    const wantsModel = (req.introduction || req.conclusion) && req.model;
    if ((req.introduction || req.conclusion) && !req.model) throw new StudioError('VALIDATION_FAILED', 'Choose a model for the introduction or conclusion review');
    const chars = (bs: typeof blocks) => bs.reduce((n, b) => n + b.text.length, 0);
    const model = wantsModel ? await this.privacy.resolve(projectId, req.model!, 'review', { manuscriptChars: (req.introduction ? chars(intro) : 0) + (req.conclusion ? chars(concl) : 0), sourceChars: 0, passages: 0, requests: Number(req.introduction) + Number(req.conclusion), preview: { claims: [...intro, ...concl].slice(0, 3).map((b) => b.text.slice(0, 200)), passages: [] } }, actor) : null;
    const reviewId = `emr_${randomId(10)}`;
    this.db.insert(schema.manuscriptReviews).values({ id: reviewId, projectId, documentRevision: synced.revision, reviewScope: req.scope, scopeDetail: { sectionPath: req.sectionPath ?? null, claimIds: req.claimIds ?? null }, status: 'running', modelProvider: model?.providerId ?? null, modelId: model?.model ?? null, promptVersion: model ? WRITING_PROMPT_VERSION : null, startedAt: now() }).run();
    const job = this.jobs.start(projectId, 'review', { key: 'review', reviewId }, model, async (ctx) => {
      try {
        let claims = this.coverageClaims(projectId);
        if (req.scope === 'section' && req.sectionPath) claims = claims.filter((c) => c.sectionPath === req.sectionPath || c.sectionPath.startsWith(`${req.sectionPath} > `));
        if (req.scope === 'claims' && req.claimIds) claims = claims.filter((c) => req.claimIds!.includes(c.id));
        const coverage = computeCoverage(claims);
        const sections = summariseSections(claims);
        const prose = blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'list-item' || b.kind === 'caption');
        const scoped = req.scope === 'section' && req.sectionPath ? prose.filter((b) => b.sectionPath.startsWith(req.sectionPath!)) : prose;
        const findings = scoped.flatMap((b) => analyseParagraph(b.text).findings.filter((f) => f.severity !== 'info').map((f) => ({ ...f, sectionPath: b.sectionPath, filePath: b.filePath })));
        const byOperation: Record<string, number> = {};
        for (const f of findings) byOperation[f.operation] = (byOperation[f.operation] ?? 0) + 1;
        const result: Record<string, unknown> = { sections, findings: findings.slice(0, 300), findingCounts: byOperation };
        if (model && req.introduction && intro.length) {
          ctx.progress(0, 2, 'Reviewing the introduction');
          const sentences = intro.flatMap((b) => b.sentences.map((s) => s.text));
          const cited = new Set(intro.flatMap((b) => citedKeys(b.text)));
          const r = await reviewIntroduction(this.target(model, ctx), sentences, { citedWorks: cited.size, title: null }).catch(rethrow);
          ctx.account({ manuscriptChars: chars(intro), requests: 1 }, r.usage);
          result.introduction = { review: r.review, sentences };
        }
        if (model && req.conclusion && concl.length) {
          ctx.progress(1, 2, 'Reviewing the conclusion');
          const sentences = concl.flatMap((b) => b.sentences.map((s) => s.text));
          const all = blocks.flatMap((b) => b.sentences.map((s) => s.text));
          const objectives = all.filter((s) => /\bwe (aim|propose|present|study|investigate|demonstrate|show|develop|introduce)\b/i.test(s)).slice(0, 15);
          const results = all.filter((s) => /\bwe (find|found|observe|obtain|measure|show)\b|\bresults? (show|indicate|suggest)/i.test(s) && !sentences.includes(s)).slice(0, 40);
          const r = await reviewConclusion(this.target(model, ctx), sentences, { objectives, results }).catch(rethrow);
          ctx.account({ manuscriptChars: chars(concl) + objectives.join('').length + results.join('').length, requests: 1 }, r.usage);
          result.conclusion = { review: r.review, sentences };
        }
        this.db.update(schema.manuscriptReviews).set({ status: 'completed', coverage: coverage as unknown as Record<string, unknown>, result, completedAt: now() }).where(eq(schema.manuscriptReviews.id, reviewId)).run();
        this.audit.record({ action: 'evidence.review.manuscript', outcome: 'success', actor: actor.sessionId, projectId, target: reviewId, details: { scope: req.scope, model: model?.model ?? null } });
        return { reviewId };
      } catch (err) {
        this.db.update(schema.manuscriptReviews).set({ status: ctx.signal.aborted ? 'cancelled' : 'failed', completedAt: now() }).where(eq(schema.manuscriptReviews.id, reviewId)).run();
        throw err;
      }
    });
    return { review: this.reviewView(reviewId), job };
  }

  private reviewView(id: string) {
    const r = this.db.select().from(schema.manuscriptReviews).where(eq(schema.manuscriptReviews.id, id)).get();
    if (!r) return null;
    return { id: r.id, projectId: r.projectId, documentRevision: r.documentRevision, reviewScope: r.reviewScope, status: r.status, coverage: (r.coverage as never) ?? null, result: r.result ?? null, modelId: r.modelId, startedAt: r.startedAt, completedAt: r.completedAt };
  }

  latestReview(projectId: string) {
    this.projects.get(projectId);
    const r = this.db.select({ id: schema.manuscriptReviews.id }).from(schema.manuscriptReviews).where(eq(schema.manuscriptReviews.projectId, projectId)).orderBy(desc(schema.manuscriptReviews.startedAt)).limit(1).get();
    return { review: r ? this.reviewView(r.id) : null, job: null };
  }

  /** Line ranges of claims per file, for quiet indicators in the editor. */
  async markers(projectId: string) {
    const { claims } = await this.listClaims(projectId, {});
    const files: Record<string, { claimId: string; fromLine: number; toLine: number; status: ClaimStatus }[]> = {};
    for (const c of claims) if (c.anchor.lines) (files[c.anchor.filePath] ??= []).push({ claimId: c.id, fromLine: c.anchor.lines.from, toLine: c.anchor.lines.to, status: c.status });
    return { files };
  }

  // ----------------------------------------------------------- settings

  settings(projectId: string) {
    this.projects.get(projectId);
    return { settings: this.privacy.settings(projectId) };
  }

  updateSettings(projectId: string, patch: Partial<EvidenceSettings>, actor: Actor) {
    this.projects.get(projectId);
    return { settings: this.privacy.update(projectId, patch, actor) };
  }

  /** Delete the project's analysis (claims, anchors, evidence links, reviews, jobs). The library and the source snapshots are kept. */
  deleteAnalysis(projectId: string, actor: Actor) {
    this.projects.get(projectId);
    const counts = { claims: 0 };
    this.db.transaction((tx) => {
      counts.claims = tx.select({ id: schema.scientificClaims.id }).from(schema.scientificClaims).where(eq(schema.scientificClaims.projectId, projectId)).all().length;
      tx.delete(schema.scientificClaims).where(eq(schema.scientificClaims.projectId, projectId)).run();
      tx.delete(schema.manuscriptBlocks).where(eq(schema.manuscriptBlocks.projectId, projectId)).run();
      tx.delete(schema.manuscriptRevisions).where(eq(schema.manuscriptRevisions.projectId, projectId)).run();
      tx.delete(schema.writingSuggestions).where(eq(schema.writingSuggestions.projectId, projectId)).run();
      tx.delete(schema.manuscriptReviews).where(eq(schema.manuscriptReviews.projectId, projectId)).run();
      tx.delete(schema.evidenceJobs).where(and(eq(schema.evidenceJobs.projectId, projectId), ne(schema.evidenceJobs.status, 'running'))).run();
    });
    this.audit.record({ action: 'evidence.delete', outcome: 'success', actor: actor.sessionId, projectId, details: counts });
    this.events.publish({ type: 'evidence.claims', projectId, claimIds: [] });
    return counts;
  }

  jobList(projectId: string) {
    this.projects.get(projectId);
    return { jobs: this.jobs.list(projectId) };
  }

  job(jobId: string) {
    const j = this.jobs.get(jobId);
    this.projects.get(j.projectId);
    return j;
  }

  /** Identifies a request target for audit without the text. */
  static fingerprint(text: string): string {
    return sha256(text).slice(0, 12);
  }
}

export type { ModelTarget };
