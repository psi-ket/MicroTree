import { and, eq, inArray, ne } from 'drizzle-orm';
import { assignIdentities, identityHash, manuscriptRevision, parseManuscript, PARSER_VERSION, reconcile, type ParsedManuscript, type StoredBlock, type StoredClaimAnchor } from '@research-studio/claim-anchors';
import { schema, type StudioDb } from '@research-studio/database';
import { normalizeClaimText } from '@research-studio/evidence-engine';
import type { FileTreeNode } from '@research-studio/shared-types';
import { randomId } from '../../security/tokens';
import type { ProjectService } from '../project-service';

const MAX_TEX_FILES = 400;

function texFiles(node: FileTreeNode, out: string[] = []): string[] {
  if (node.type === 'file' && /\.(tex|ltx)$/i.test(node.path)) out.push(node.path);
  for (const c of node.children ?? []) texFiles(c, out);
  return out;
}

export interface SyncResult {
  revision: string;
  parsed: ParsedManuscript;
  /** Claims whose anchor or status changed. */
  changedClaimIds: string[];
  summary: Record<string, number>;
}

/** Line number (1-based) of an offset. */
export function lineAt(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Keeps the stored manuscript structure (blocks, sentences) and the claim
 * anchors in step with the project's files. Each sync parses the manuscript
 * from its root file, reconciles it with what is stored, and records what
 * happened to every claim: unchanged and moved claims follow their text;
 * minor edits are `modified`; material edits are `needs_revalidation` (their
 * assessments become stale, never transferred); removed text is archived
 * with its history. Syncs of one project never overlap.
 */
export class ManuscriptSync {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: StudioDb,
    private readonly projects: ProjectService,
  ) {}

  /** The manuscript's files, read once. */
  async readFiles(projectId: string): Promise<{ root: string; files: Map<string, string>; hashes: Map<string, string> }> {
    const project = this.projects.get(projectId);
    const paths = texFiles(await this.projects.tree(projectId)).slice(0, MAX_TEX_FILES);
    const files = new Map<string, string>();
    const hashes = new Map<string, string>();
    for (const p of paths) {
      try {
        const f = await this.projects.readFile(projectId, p);
        files.set(p, f.content);
        hashes.set(p, f.hash);
      } catch {
        // unreadable files are left out
      }
    }
    return { root: project.mainFile, files, hashes };
  }

  sync(projectId: string): Promise<SyncResult> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.run(projectId));
    this.chains.set(projectId, next);
    return next;
  }

  private storedBlocks(projectId: string): StoredBlock[] {
    const blocks = this.db.select().from(schema.manuscriptBlocks).where(and(eq(schema.manuscriptBlocks.projectId, projectId), ne(schema.manuscriptBlocks.status, 'deleted'))).all();
    const sentences = this.db.select().from(schema.manuscriptSentences).where(eq(schema.manuscriptSentences.projectId, projectId)).all();
    const byBlock = new Map<string, typeof sentences>();
    for (const s of sentences) byBlock.set(s.blockId, [...(byBlock.get(s.blockId) ?? []), s]);
    return blocks
      .sort((a, b) => a.blockOrder - b.blockOrder)
      .map((b) => {
        const ss = (byBlock.get(b.id) ?? []).sort((x, y) => x.sentenceOrder - y.sentenceOrder);
        return {
          id: b.id,
          filePath: b.filePath,
          kind: b.kind,
          text: b.text,
          hash: b.textHash,
          prefix: b.prefixContext,
          suffix: b.suffixContext,
          order: b.blockOrder,
          sentences: ss.map((s, j) => ({ id: s.id, blockId: b.id, order: s.sentenceOrder, text: s.text, hash: s.textHash, prefix: j > 0 ? ss[j - 1]!.text.toLowerCase().slice(-64) : b.prefixContext, suffix: j + 1 < ss.length ? ss[j + 1]!.text.toLowerCase().slice(0, 64) : b.suffixContext })),
        };
      });
  }

  private async run(projectId: string): Promise<SyncResult> {
    const { root, files, hashes } = await this.readFiles(projectId);
    const parsed = parseManuscript(files.has(root) ? root : ([...files.keys()][0] ?? root), files);
    const revision = manuscriptRevision(parsed.files.map((p) => ({ path: p, content: files.get(p) ?? '' })));
    const stored = this.storedBlocks(projectId);
    const claimRows = this.db
      .select({ claim: schema.scientificClaims, anchor: schema.claimAnchors })
      .from(schema.scientificClaims)
      .innerJoin(schema.claimAnchors, eq(schema.claimAnchors.claimId, schema.scientificClaims.id))
      .where(and(eq(schema.scientificClaims.projectId, projectId), ne(schema.scientificClaims.reviewState, 'archived')))
      .all();
    const anchors: StoredClaimAnchor[] = claimRows.map(({ claim, anchor }) => ({
      claimId: claim.id,
      blockId: anchor.blockId,
      sentenceId: anchor.sentenceId,
      filePath: anchor.filePath,
      claimText: claim.claimText,
      verbatim: claim.spanStart !== null,
      textSnapshot: anchor.textSnapshot,
    }));
    const result = stored.length ? reconcile(stored, parsed, anchors) : null;
    const identified = assignIdentities(parsed, result);
    const ts = new Date().toISOString();
    const statusOf = new Map(result?.blocks.map((b) => [b.key, b.status]) ?? []);
    const sentenceStatus = new Map(result?.sentences.map((s) => [s.key, s.status]) ?? []);
    const changed: string[] = [];

    this.db.transaction((tx) => {
      // Revisions: one row per file content seen.
      for (const p of parsed.files) {
        const h = hashes.get(p) ?? '';
        const seen = tx.select({ id: schema.manuscriptRevisions.id }).from(schema.manuscriptRevisions).where(and(eq(schema.manuscriptRevisions.projectId, projectId), eq(schema.manuscriptRevisions.filePath, p), eq(schema.manuscriptRevisions.fileHash, h))).get();
        if (!seen) tx.insert(schema.manuscriptRevisions).values({ id: `mrv_${randomId(10)}`, projectId, filePath: p, fileHash: h, parserVersion: PARSER_VERSION, blockCount: parsed.blocks.filter((b) => b.filePath === p).length, createdAt: ts }).run();
      }
      const existing = new Set(stored.map((b) => b.id));
      for (const r of result?.removedBlocks ?? []) tx.update(schema.manuscriptBlocks).set({ status: r.status, updatedAt: ts }).where(eq(schema.manuscriptBlocks.id, r.id)).run();
      tx.delete(schema.manuscriptSentences).where(eq(schema.manuscriptSentences.projectId, projectId)).run();
      const parsedByKey = new Map(parsed.blocks.map((b) => [b.key, b]));
      for (const b of identified.blocks) {
        const p = parsedByKey.get(b.key)!;
        const row = {
          projectId,
          filePath: b.filePath,
          kind: b.kind,
          sectionId: b.sectionId,
          sectionPath: p.sectionPath,
          parentBlockId: b.parentId,
          blockOrder: b.order,
          text: b.text,
          textHash: b.hash,
          prefixContext: b.prefix,
          suffixContext: b.suffix,
          startOffset: p.start,
          endOffset: p.end,
          structurePath: p.structurePath,
          revisionId: revision,
          status: statusOf.get(b.key) ?? 'current',
          updatedAt: ts,
        };
        if (existing.has(b.id)) tx.update(schema.manuscriptBlocks).set(row).where(eq(schema.manuscriptBlocks.id, b.id)).run();
        else tx.insert(schema.manuscriptBlocks).values({ id: b.id, ...row, createdAt: ts }).run();
        for (const s of b.sentences) {
          const ps = p.sentences[s.order]!;
          tx.insert(schema.manuscriptSentences).values({ id: s.id, blockId: b.id, projectId, sentenceOrder: s.order, text: s.text, textHash: s.hash, startOffset: ps.start, endOffset: ps.end, status: sentenceStatus.get(ps.key) ?? 'current', updatedAt: ts }).run();
        }
      }

      // Claims follow their text.
      const byClaim = new Map(claimRows.map((r) => [r.claim.id, r]));
      for (const m of result?.claims ?? []) {
        const row = byClaim.get(m.claimId)!;
        const blockId = m.blockKey ? identified.ids.get(m.blockKey)! : row.anchor.blockId;
        const sentenceId = m.sentenceKey ? (identified.ids.get(m.sentenceKey) ?? null) : null;
        const block = m.blockKey ? identified.blocks.find((b) => b.key === m.blockKey) : null;
        const pBlock = m.blockKey ? parsedByKey.get(m.blockKey) : null;
        const pSentence = m.sentenceKey && pBlock ? pBlock.sentences.find((s) => s.key === m.sentenceKey) : null;
        const sameText = m.newText !== null && m.newText === row.anchor.textSnapshot && m.filePath === row.anchor.filePath;
        // Nothing changed: keep what is stored (a pending revalidation is not cleared by an unrelated sync).
        if (m.status === 'current' && sameText && blockId === row.anchor.blockId && sentenceId === row.anchor.sentenceId) continue;
        changed.push(m.claimId);
        if (m.status === 'deleted') {
          tx.update(schema.claimAnchors).set({ mappingStatus: 'deleted', revision, updatedAt: ts }).where(eq(schema.claimAnchors.claimId, m.claimId)).run();
          tx.update(schema.scientificClaims).set({ reviewState: 'archived', updatedAt: ts }).where(eq(schema.scientificClaims.id, m.claimId)).run();
          continue;
        }
        if (m.status === 'unmatched' || !m.newText || !block) {
          tx.update(schema.claimAnchors).set({ mappingStatus: 'unmatched', revision, updatedAt: ts }).where(eq(schema.claimAnchors.claimId, m.claimId)).run();
          continue;
        }
        // A claim that was the whole sentence takes the new wording; a partial span keeps its words and gets a new span when found.
        const wholeSentence = row.claim.spanStart === 0 && row.claim.spanEnd !== null && row.claim.spanEnd >= row.claim.originalText.replace(/\s+$/, '').length - 1;
        const claimText = m.span ? m.newText.slice(m.span.start, m.span.end) : wholeSentence ? m.newText.trim() : row.claim.claimText;
        const span = m.span ?? (wholeSentence ? { start: 0, end: m.newText.trim().length } : null);
        // Statuses only escalate until the claim is revalidated: modified, then needs_revalidation.
        const rank = { current: 0, modified: 1, needs_revalidation: 2, unmatched: 0, deleted: 0 } as const;
        const status = rank[row.anchor.mappingStatus] > rank[m.status] ? row.anchor.mappingStatus : m.status;
        const material = m.status === 'needs_revalidation';
        tx.update(schema.claimAnchors)
          .set({
            filePath: m.filePath!,
            blockId,
            sentenceId,
            sectionId: block.sectionId,
            sectionPath: pBlock!.sectionPath,
            parentBlockId: block.parentId,
            textSnapshot: m.newText,
            prefixContext: pSentence?.prefix ?? block.prefix,
            suffixContext: pSentence?.suffix ?? block.suffix,
            textHash: identityHash(m.newText),
            revision,
            startOffset: pBlock!.start,
            endOffset: pBlock!.end,
            structurePath: pBlock!.structurePath,
            mappingStatus: status,
            ...(m.status !== 'current' ? { previousText: row.anchor.previousText && status !== 'current' ? row.anchor.previousText : row.anchor.textSnapshot } : {}),
            updatedAt: ts,
          })
          .where(eq(schema.claimAnchors.claimId, m.claimId))
          .run();
        tx.update(schema.scientificClaims)
          .set({
            documentBlockId: blockId,
            sentenceId,
            originalText: m.newText,
            claimText,
            spanStart: span?.start ?? null,
            spanEnd: span?.end ?? null,
            normalizedText: normalizeClaimText(claimText),
            textHash: identityHash(claimText),
            documentRevision: revision,
            ...(material ? { status: 'needs_revalidation' as const } : {}),
            updatedAt: ts,
          })
          .where(eq(schema.scientificClaims.id, m.claimId))
          .run();
        if (material) {
          tx.update(schema.evidenceAssessments).set({ status: 'stale' }).where(and(eq(schema.evidenceAssessments.claimId, m.claimId), eq(schema.evidenceAssessments.status, 'current'))).run();
          tx.update(schema.conflictAnalyses).set({ status: 'stale' }).where(and(eq(schema.conflictAnalyses.claimId, m.claimId), eq(schema.conflictAnalyses.status, 'current'))).run();
          tx.update(schema.citationRecommendations).set({ status: 'superseded', updatedAt: ts }).where(and(eq(schema.citationRecommendations.claimId, m.claimId), inArray(schema.citationRecommendations.status, ['proposed']))).run();
        }
      }
    });
    return { revision, parsed, changedClaimIds: changed, summary: { ...(result?.summary ?? {}), blocks: parsed.blocks.length } };
  }
}
