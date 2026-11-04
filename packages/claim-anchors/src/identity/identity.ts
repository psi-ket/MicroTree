import { randomUUID } from 'node:crypto';
import type { ParsedManuscript } from '../parser/manuscript';
import type { ReconcileResult, StoredBlock } from '../reconciliation/reconcile';

export const newBlockId = () => `mbk_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const newSentenceId = () => `msn_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export interface IdentifiedManuscript {
  blocks: (StoredBlock & { key: string; sectionId: string | null; parentId: string | null })[];
  /** Parse key → identity, for blocks and sentences. */
  ids: Map<string, string>;
}

/**
 * Give every block and sentence of a parse its identity: the one carried
 * over by reconciliation, or a new one. Without a previous version
 * (`result` null) everything is new.
 */
export function assignIdentities(parsed: ParsedManuscript, result: ReconcileResult | null, ids = { block: newBlockId, sentence: newSentenceId }): IdentifiedManuscript {
  const map = new Map<string, string>();
  const usedBlockIds = new Set<string>();
  const blockMap = new Map(result?.blocks.map((b) => [b.key, b.id]) ?? []);
  const sentenceMap = new Map(result?.sentences.map((s) => [s.key, s.id]) ?? []);
  for (const b of parsed.blocks) {
    let id = blockMap.get(b.key) ?? null;
    if (!id || usedBlockIds.has(id)) id = ids.block();
    usedBlockIds.add(id);
    map.set(b.key, id);
  }
  const used = new Set<string>();
  const blocks = parsed.blocks.map((b) => {
    const id = map.get(b.key)!;
    return {
      key: b.key,
      id,
      filePath: b.filePath,
      kind: b.kind,
      text: b.text,
      hash: b.hash,
      prefix: b.prefix,
      suffix: b.suffix,
      order: b.order,
      sectionId: b.sectionKey ? (map.get(b.sectionKey) ?? null) : null,
      parentId: b.parentKey ? (map.get(b.parentKey) ?? null) : null,
      sentences: b.sentences.map((s) => {
        let sid = sentenceMap.get(s.key) ?? null;
        if (!sid || used.has(sid)) sid = ids.sentence();
        used.add(sid);
        map.set(s.key, sid);
        return { id: sid, blockId: id, order: s.order, text: s.text, hash: s.hash, prefix: s.prefix, suffix: s.suffix };
      }),
    };
  });
  return { blocks, ids: map };
}
