import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';
import {
  PARSER_VERSION,
  SEGMENTER_VERSION,
  TERMINAL_JOB_STATUSES,
  type DocumentJobKind,
  type DocumentJobStatus,
  type ExtractionStatus,
  type JobError,
  type NormalizedDocument,
  type PassageDraft,
} from '@research-studio/document-intelligence';

export const newDocumentId = (prefix: 'dex' | 'djb') => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export type ExtractionRow = typeof schema.documentExtractions.$inferSelect;
export type JobRow = typeof schema.documentJobs.$inferSelect;
export type SectionRow = typeof schema.documentSections.$inferSelect;
export type BlockRow = typeof schema.documentBlocks.$inferSelect;
export type PassageRow = typeof schema.documentPassages.$inferSelect;
export type SentenceRow = typeof schema.documentSentences.$inferSelect;
export type ReferenceRow = typeof schema.documentReferences.$inferSelect;
export type ElementRow = typeof schema.documentElements.$inferSelect;

export interface AttachmentInfo {
  attachmentId: string;
  libraryItemId: string;
  scholarlyWorkId: string;
  sha256: string;
  storageKey: string;
  attachmentType: string;
  fileSize: number;
}

export interface SaveExtractionInput {
  attachment: AttachmentInfo;
  document: NormalizedDocument;
  passages: PassageDraft[];
  status: ExtractionStatus;
  config: Record<string, unknown>;
  configHash: string;
  raw: { format: 'tei-xml' | 'pymupdf-json'; content: string } | null;
  startedAt: string;
}

const scoped = (extractionId: string, key: string) => `${extractionId}_${key}`;

/**
 * Persistence for extractions, their structures and passages, and jobs. All
 * writes of one extraction happen in one transaction, and a new extraction
 * is written inactive: it replaces the active one only through `activate`,
 * after it has been checked and indexed.
 */
export class DocumentStore {
  constructor(
    private readonly db: StudioDb,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  // ---------------------------------------------------------- attachments

  attachmentInfo(attachmentId: string): AttachmentInfo | null {
    const row = this.db
      .select({
        attachmentId: schema.libraryAttachments.id,
        libraryItemId: schema.libraryAttachments.libraryItemId,
        scholarlyWorkId: schema.libraryItems.scholarlyWorkId,
        sha256: schema.libraryAttachments.sha256,
        storageKey: schema.libraryAttachments.storageKey,
        attachmentType: schema.libraryAttachments.attachmentType,
        fileSize: schema.libraryAttachments.fileSize,
      })
      .from(schema.libraryAttachments)
      .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.libraryAttachments.libraryItemId))
      .where(eq(schema.libraryAttachments.id, attachmentId))
      .get();
    return row ?? null;
  }

  /** PDF attachments of items that are not archived and have no active extraction. */
  unprocessedPdfAttachments(limit = 10_000): AttachmentInfo[] {
    return this.db
      .select({
        attachmentId: schema.libraryAttachments.id,
        libraryItemId: schema.libraryAttachments.libraryItemId,
        scholarlyWorkId: schema.libraryItems.scholarlyWorkId,
        sha256: schema.libraryAttachments.sha256,
        storageKey: schema.libraryAttachments.storageKey,
        attachmentType: schema.libraryAttachments.attachmentType,
        fileSize: schema.libraryAttachments.fileSize,
      })
      .from(schema.libraryAttachments)
      .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.libraryAttachments.libraryItemId))
      .where(
        and(
          eq(schema.libraryAttachments.attachmentType, 'pdf'),
          sql`${schema.libraryItems.archivedAt} IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM document_extractions x WHERE x.attachment_id = ${schema.libraryAttachments.id} AND x.is_active = 1)`,
        ),
      )
      .orderBy(asc(schema.libraryAttachments.createdAt))
      .limit(limit)
      .all();
  }

  // ---------------------------------------------------------- extractions

  saveExtraction(input: SaveExtractionInput): string {
    const id = newDocumentId('dex');
    const ts = this.now();
    const doc = input.document;
    this.db.transaction((tx) => {
      tx.insert(schema.documentExtractions)
        .values({
          id,
          attachmentId: input.attachment.attachmentId,
          libraryItemId: input.attachment.libraryItemId,
          scholarlyWorkId: input.attachment.scholarlyWorkId,
          sourceSha256: input.attachment.sha256,
          extractor: doc.extractor,
          extractorVersion: doc.extractorVersion,
          parserVersion: PARSER_VERSION,
          segmenterVersion: SEGMENTER_VERSION,
          config: input.config,
          configHash: input.configHash,
          status: input.status,
          isActive: false,
          language: doc.metadata.language,
          pageCount: doc.pages.length || null,
          pages: doc.pages,
          metadata: doc.metadata,
          quality: doc.quality,
          warnings: doc.warnings,
          processingStartedAt: input.startedAt,
          processingCompletedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      if (input.raw) {
        const content = gzipSync(Buffer.from(input.raw.content, 'utf8'));
        tx.insert(schema.documentRawOutputs).values({ extractionId: id, format: input.raw.format, encoding: 'gzip', content, sizeBytes: Buffer.byteLength(input.raw.content, 'utf8') }).run();
      }
      const elementId = (key: string | null) => (key ? scoped(id, key) : null);
      for (const s of doc.sections) {
        tx.insert(schema.documentSections)
          .values({
            id: scoped(id, s.key),
            extractionId: id,
            parentSectionId: s.parentKey ? scoped(id, s.parentKey) : null,
            heading: s.heading,
            headingNumber: s.number,
            sectionLevel: s.level,
            sectionOrder: s.order,
            sectionPath: s.path,
            sectionType: s.type,
            pageStart: s.pageStart,
            pageEnd: s.pageEnd,
            coordinates: s.coordinates,
          })
          .run();
      }
      for (const b of doc.blocks) {
        tx.insert(schema.documentBlocks)
          .values({
            id: scoped(id, b.key),
            extractionId: id,
            sectionId: b.sectionKey ? scoped(id, b.sectionKey) : null,
            blockType: b.type,
            blockOrder: b.order,
            content: b.spans,
            plainText: b.plainText,
            sourceXmlId: b.sourceId,
            elementId: elementId(b.elementKey),
            sentenceSource: b.sentenceSource,
            pageStart: b.pageStart,
            pageEnd: b.pageEnd,
            coordinates: b.coordinates,
          })
          .run();
      }
      doc.elements.forEach((e, i) => {
        tx.insert(schema.documentElements)
          .values({
            id: scoped(id, e.key),
            extractionId: id,
            sectionId: e.sectionKey ? scoped(id, e.sectionKey) : null,
            elementType: e.type,
            elementOrder: i,
            label: e.label,
            caption: e.caption,
            content: e.content,
            sourceXmlId: e.sourceId,
            pageStart: e.pageStart,
            pageEnd: e.pageEnd,
            coordinates: e.coordinates,
          })
          .run();
      });
      for (const r of doc.references) {
        tx.insert(schema.documentReferences)
          .values({
            id: scoped(id, r.key),
            extractionId: id,
            referenceOrder: r.order,
            rawReference: r.raw,
            parsedMetadata: r.parsed,
            doi: r.doi,
            arxivId: r.arxivId,
            sourceXmlId: r.sourceId,
            pageStart: r.pageStart,
            pageEnd: r.pageEnd,
            coordinates: r.coordinates,
          })
          .run();
      }
      const sentencePassage = new Map<string, string>();
      for (const p of input.passages) {
        const pid = scoped(id, `p${p.order}`);
        for (const s of p.sentences) if (!sentencePassage.has(`${s.blockKey}#${s.order}`)) sentencePassage.set(`${s.blockKey}#${s.order}`, pid);
        tx.insert(schema.documentPassages)
          .values({
            id: pid,
            extractionId: id,
            sectionId: p.sectionKey ? scoped(id, p.sectionKey) : null,
            parentBlockId: p.blockKeys[0] ? scoped(id, p.blockKeys[0]) : null,
            blockIds: p.blockKeys.map((k) => scoped(id, k)),
            passageOrder: p.order,
            kind: p.kind,
            sectionPath: p.sectionPath,
            sectionType: p.sectionType,
            text: p.text,
            normalizedText: p.normalizedText,
            textHash: p.textHash,
            stableKey: p.stableKey,
            pageStart: p.pageStart,
            pageEnd: p.pageEnd,
            coordinates: p.coordinates,
            tokenCount: p.tokenCount,
            language: p.language,
            createdAt: ts,
          })
          .run();
      }
      for (const b of doc.blocks) {
        for (const s of b.sentences) {
          tx.insert(schema.documentSentences)
            .values({
              id: scoped(id, `${b.key}s${s.order}`),
              extractionId: id,
              blockId: scoped(id, b.key),
              passageId: sentencePassage.get(`${b.key}#${s.order}`) ?? null,
              sentenceOrder: s.order,
              text: s.text,
              textHash: '',
              pageStart: s.pageStart,
              pageEnd: s.pageEnd,
              coordinates: s.coordinates,
            })
            .run();
        }
      }
    });
    return id;
  }

  /**
   * Make an extraction the active one for its attachment and delete the
   * extractions it replaces (their passages, index rows and vector links go
   * with them). Returns the IDs that were replaced.
   */
  activate(extractionId: string): string[] {
    return this.db.transaction((tx) => {
      const row = tx.select().from(schema.documentExtractions).where(eq(schema.documentExtractions.id, extractionId)).get();
      if (!row) throw new Error('Extraction not found');
      const others = tx
        .select({ id: schema.documentExtractions.id })
        .from(schema.documentExtractions)
        .where(and(eq(schema.documentExtractions.attachmentId, row.attachmentId), sql`${schema.documentExtractions.id} <> ${extractionId}`))
        .all()
        .map((r) => r.id);
      if (others.length) tx.delete(schema.documentExtractions).where(inArray(schema.documentExtractions.id, others)).run();
      tx.update(schema.documentExtractions).set({ isActive: true, updatedAt: this.now() }).where(eq(schema.documentExtractions.id, extractionId)).run();
      return others;
    });
  }

  deleteExtraction(extractionId: string): void {
    this.db.delete(schema.documentExtractions).where(eq(schema.documentExtractions.id, extractionId)).run();
  }

  /** Inactive extractions left by an interrupted run (never the active one). */
  deleteInactiveExtractions(attachmentId?: string): number {
    const where = attachmentId
      ? and(eq(schema.documentExtractions.isActive, false), eq(schema.documentExtractions.attachmentId, attachmentId))
      : eq(schema.documentExtractions.isActive, false);
    return this.db.delete(schema.documentExtractions).where(where).run().changes;
  }

  getExtraction(id: string): ExtractionRow | null {
    return this.db.select().from(schema.documentExtractions).where(eq(schema.documentExtractions.id, id)).get() ?? null;
  }

  activeExtraction(attachmentId: string): ExtractionRow | null {
    return (
      this.db
        .select()
        .from(schema.documentExtractions)
        .where(and(eq(schema.documentExtractions.attachmentId, attachmentId), eq(schema.documentExtractions.isActive, true)))
        .get() ?? null
    );
  }

  activeExtractions(): ExtractionRow[] {
    return this.db.select().from(schema.documentExtractions).where(eq(schema.documentExtractions.isActive, true)).all();
  }

  rawOutput(extractionId: string): { format: string; content: string } | null {
    const row = this.db.select().from(schema.documentRawOutputs).where(eq(schema.documentRawOutputs.extractionId, extractionId)).get();
    return row ? { format: row.format, content: gunzipSync(row.content).toString('utf8') } : null;
  }

  sections(extractionId: string): SectionRow[] {
    return this.db.select().from(schema.documentSections).where(eq(schema.documentSections.extractionId, extractionId)).orderBy(asc(schema.documentSections.sectionOrder)).all();
  }

  blocks(extractionId: string): BlockRow[] {
    return this.db.select().from(schema.documentBlocks).where(eq(schema.documentBlocks.extractionId, extractionId)).orderBy(asc(schema.documentBlocks.blockOrder)).all();
  }

  elements(extractionId: string): ElementRow[] {
    return this.db.select().from(schema.documentElements).where(eq(schema.documentElements.extractionId, extractionId)).orderBy(asc(schema.documentElements.elementOrder)).all();
  }

  references(extractionId: string): ReferenceRow[] {
    return this.db.select().from(schema.documentReferences).where(eq(schema.documentReferences.extractionId, extractionId)).orderBy(asc(schema.documentReferences.referenceOrder)).all();
  }

  passages(extractionId: string, opts: { offset?: number; limit?: number } = {}): { passages: PassageRow[]; total: number } {
    const total = this.db.select({ n: sql<number>`count(*)` }).from(schema.documentPassages).where(eq(schema.documentPassages.extractionId, extractionId)).get()!.n;
    const passages = this.db
      .select()
      .from(schema.documentPassages)
      .where(eq(schema.documentPassages.extractionId, extractionId))
      .orderBy(asc(schema.documentPassages.passageOrder))
      .limit(opts.limit ?? 10_000)
      .offset(opts.offset ?? 0)
      .all();
    return { passages, total };
  }

  passage(passageId: string): PassageRow | null {
    return this.db.select().from(schema.documentPassages).where(eq(schema.documentPassages.id, passageId)).get() ?? null;
  }

  passagesByIds(ids: readonly string[]): PassageRow[] {
    if (!ids.length) return [];
    return this.db.select().from(schema.documentPassages).where(inArray(schema.documentPassages.id, [...ids])).all();
  }

  /** The passages just before and after one passage, for context. */
  neighbours(passage: PassageRow, before = 1, after = 1): PassageRow[] {
    return this.db
      .select()
      .from(schema.documentPassages)
      .where(
        and(
          eq(schema.documentPassages.extractionId, passage.extractionId),
          sql`${schema.documentPassages.passageOrder} BETWEEN ${passage.passageOrder - before} AND ${passage.passageOrder + after}`,
          sql`${schema.documentPassages.id} <> ${passage.id}`,
        ),
      )
      .orderBy(asc(schema.documentPassages.passageOrder))
      .all();
  }

  sentencesOf(passageId: string): SentenceRow[] {
    return this.db.select().from(schema.documentSentences).where(eq(schema.documentSentences.passageId, passageId)).orderBy(asc(schema.documentSentences.blockId), asc(schema.documentSentences.sentenceOrder)).all();
  }

  // ----------------------------------------------------------------- jobs

  createJob(input: { kind: DocumentJobKind; attachment: AttachmentInfo; configHash: string; previousExtractionId: string | null; retryCount?: number }): JobRow {
    const ts = this.now();
    const row: typeof schema.documentJobs.$inferInsert = {
      id: newDocumentId('djb'),
      kind: input.kind,
      attachmentId: input.attachment.attachmentId,
      libraryItemId: input.attachment.libraryItemId,
      configHash: input.configHash,
      status: 'queued',
      previousExtractionId: input.previousExtractionId,
      retryCount: input.retryCount ?? 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.insert(schema.documentJobs).values(row).run();
    return this.getJob(row.id)!;
  }

  getJob(id: string): JobRow | null {
    return this.db.select().from(schema.documentJobs).where(eq(schema.documentJobs.id, id)).get() ?? null;
  }

  updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'error' | 'attempts' | 'extractionId' | 'notes' | 'startedAt' | 'finishedAt'>>): JobRow {
    this.db.update(schema.documentJobs).set({ ...patch, updatedAt: this.now() }).where(eq(schema.documentJobs.id, id)).run();
    return this.getJob(id)!;
  }

  unfinishedJob(attachmentId: string, configHash?: string): JobRow | null {
    const conds = [eq(schema.documentJobs.attachmentId, attachmentId), notInArray(schema.documentJobs.status, [...TERMINAL_JOB_STATUSES])];
    if (configHash) conds.push(eq(schema.documentJobs.configHash, configHash));
    return this.db.select().from(schema.documentJobs).where(and(...conds)).get() ?? null;
  }

  unfinishedJobs(): JobRow[] {
    return this.db.select().from(schema.documentJobs).where(notInArray(schema.documentJobs.status, [...TERMINAL_JOB_STATUSES])).orderBy(asc(schema.documentJobs.createdAt)).all();
  }

  latestJob(attachmentId: string): JobRow | null {
    return this.db.select().from(schema.documentJobs).where(eq(schema.documentJobs.attachmentId, attachmentId)).orderBy(desc(schema.documentJobs.createdAt), desc(schema.documentJobs.id)).get() ?? null;
  }

  listJobs(opts: { statuses?: DocumentJobStatus[]; limit?: number } = {}): JobRow[] {
    const q = this.db.select().from(schema.documentJobs);
    const filtered = opts.statuses?.length ? q.where(inArray(schema.documentJobs.status, opts.statuses)) : q;
    return filtered.orderBy(desc(schema.documentJobs.createdAt)).limit(opts.limit ?? 100).all();
  }

  /** Keep only the newest `keep` finished jobs per attachment (older history is not needed). */
  pruneFinishedJobs(keep = 5): number {
    return this.db.run(sql`
      DELETE FROM document_jobs WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY attachment_id ORDER BY created_at DESC) AS rn
          FROM document_jobs WHERE status IN ('completed', 'partial', 'needs_ocr', 'failed', 'cancelled')
        ) WHERE rn > ${keep}
      )`).changes;
  }

  setJobError(id: string, status: DocumentJobStatus, error: JobError | null, notes?: string[]): JobRow {
    return this.updateJob(id, { status, error, finishedAt: this.now(), ...(notes ? { notes } : {}) });
  }
}
