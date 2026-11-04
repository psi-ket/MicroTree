export { containment, identityHash, normalizeForIdentity, sha256, similarity, tokens } from './hashing/text-hash';
export { assessChange, type Materiality } from './mapping/materiality';
export { parseLatexFile, PARSER_VERSION, resolveInclude, type IncludeRef, type ParsedBlock, type ParsedFile } from './parser/latex-blocks';
export { blockSentences, type BlockSentence } from './parser/sentences';
export { CONTEXT_CHARS, parseManuscript, type ManuscriptBlock, type ManuscriptSentence, type ParsedManuscript } from './parser/manuscript';
export { matchItems, type MatchItem, type MatchKind, type MatchPair, type MatchResult } from './reconciliation/matcher';
export { reconcile, type ClaimMapping, type MappedItem, type ReconcileResult, type RemovedItem, type StoredBlock, type StoredClaimAnchor, type StoredSentence } from './reconciliation/reconcile';
export { assignIdentities, newBlockId, newSentenceId, type IdentifiedManuscript } from './identity/identity';
export { manuscriptRevision } from './revision/revision';
