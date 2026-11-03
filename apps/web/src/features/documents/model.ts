import type { DocumentJob, ExtractionSummary } from '@research-studio/api-contracts';
import type { DocumentJobStatus, ExtractionStatus, SectionType } from '@research-studio/document-intelligence';

export const ACTIVE_JOB: readonly DocumentJobStatus[] = ['queued', 'validating', 'extracting', 'normalizing', 'segmenting', 'indexing_keywords', 'generating_embeddings', 'indexing_vectors'];
export const isActiveDocumentJob = (job: DocumentJob | null | undefined): boolean => !!job && ACTIVE_JOB.includes(job.status);

export const EXTRACTION_LABEL: Record<ExtractionStatus, string> = {
  completed: 'Full text extracted',
  partial: 'Extracted with gaps',
  needs_ocr: 'Needs OCR',
  failed: 'Extraction failed',
};

export const EXTRACTION_TONE: Record<ExtractionStatus, 'success' | 'warning' | 'danger'> = { completed: 'success', partial: 'warning', needs_ocr: 'warning', failed: 'danger' };

export const SECTION_LABEL: Record<SectionType, string> = {
  abstract: 'Abstract',
  introduction: 'Introduction',
  background: 'Background and model',
  methods: 'Methods',
  results: 'Results',
  discussion: 'Discussion',
  conclusion: 'Conclusion',
  appendix: 'Appendix',
  acknowledgement: 'Acknowledgements',
  references: 'References',
  body: 'Other body sections',
  other: 'Other',
};

export const MODE_LABEL = { hybrid: 'Hybrid', keyword: 'Keyword', semantic: 'Semantic' } as const;

export const MATCH_LABEL = { keyword: 'Keyword match', semantic: 'Semantic match', hybrid: 'Keyword and semantic' } as const;

export const STALE_LABEL: Record<string, string> = {
  'source-changed': 'the PDF changed',
  'extractor-changed': 'another extractor is configured',
  'extractor-version-changed': 'GROBID was updated',
  'parser-changed': 'the parser was updated',
  'config-changed': 'extraction settings changed',
};

export function percent(x: number | null | undefined): string {
  return x === null || x === undefined ? 'not measured' : `${Math.round(x * 100)}%`;
}

/** Short quality line for an extraction: what was found, and what was not. */
export function qualitySummary(x: ExtractionSummary): string[] {
  const q = x.quality;
  const out = [
    `${x.extractor === 'grobid' ? 'GROBID' : 'PyMuPDF'}${x.extractorVersion ? ` ${x.extractorVersion}` : ''}${q.structure === 'layout' ? ' (page layout only)' : ''}`,
    `${x.counts.sections} sections, ${x.counts.passages} passages, ${x.counts.references} references`,
    `text coverage ${percent(q.textCoverage)}`,
    `source boxes for ${percent(q.coordinateCoverage)} of blocks`,
  ];
  return out;
}

export function shortHash(sha: string): string {
  return sha.slice(0, 12);
}

/** Terms from a query to mark in result text (words of 3+ letters and quoted phrases). */
export function markTerms(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const rest = query.replace(/"[^"]*"/g, ' ');
  const words = rest
    .split(/\s+/)
    .filter((w) => !/^(AND|OR|NOT)$/.test(w) && !w.startsWith('-') && !w.includes(':'))
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((w) => w.length >= 3 || /^[\p{Script=Greek}]$/u.test(w));
  return [...new Set([...phrases, ...words])].sort((a, b) => b.length - a.length);
}
