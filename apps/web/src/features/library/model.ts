import type {
  BibChangeKind,
  CiteCommand,
  ImportItemOutcome,
  ImportJob,
  ImportJobKind,
  LibraryItemQuery,
  MatchConfidence,
  MetadataStatus,
  WorkOrigin,
} from '@research-studio/shared-types';

export { READING_STATUS_LABELS as STATUS_LABEL } from '@research-studio/shared-types';

export const METADATA_LABEL: Record<MetadataStatus, string> = {
  resolved: 'Identified',
  'needs-review': 'Check the match',
  unresolved: 'Not identified',
  manual: 'Your record',
};

/** What each metadata state means for the user, in one sentence. */
export const METADATA_HINT: Record<MetadataStatus, string> = {
  resolved: 'Details come from the scholarly sources, with your corrections on top.',
  'needs-review': 'Possible matches were found. Nothing is applied until you choose one.',
  unresolved: 'No source identified this paper. It keeps only what the file or record states.',
  manual: 'Details are as you entered or imported them.',
};

export const CONFIDENCE_LABEL: Record<MatchConfidence, string> = {
  'exact-doi': 'Same DOI',
  'exact-arxiv': 'Same arXiv ID',
  strong: 'Strong match',
  possible: 'Possible match',
  unresolved: 'No match',
};

export const ORIGIN_LABEL: Record<WorkOrigin, string> = {
  providers: 'Scholarly sources',
  bibtex: 'BibTeX import',
  ris: 'RIS import',
  pdf: 'PDF file',
  manual: 'Entered by hand',
  zotero: 'Zotero',
};

export const OUTCOME_LABEL: Record<ImportItemOutcome, string> = {
  added: 'Added',
  attached: 'PDF attached',
  duplicate: 'Already in library',
  'needs-review': 'Needs review',
  unresolved: 'Added, not identified',
  updated: 'Updated from Zotero',
  conflict: 'Changed on both sides',
  failed: 'Failed',
  skipped: 'Unchanged',
};

export const OUTCOME_DOT: Record<ImportItemOutcome, 'success' | 'warning' | 'danger' | 'neutral'> = {
  added: 'success',
  attached: 'success',
  duplicate: 'neutral',
  'needs-review': 'warning',
  unresolved: 'warning',
  updated: 'success',
  conflict: 'warning',
  failed: 'danger',
  skipped: 'neutral',
};

export const JOB_KIND_LABEL: Record<ImportJobKind, string> = {
  pdf: 'PDF import',
  bibtex: 'BibTeX import',
  ris: 'RIS import',
  identifiers: 'DOI and arXiv import',
  zotero: 'Zotero',
};

export const CITE_LABEL: Record<CiteCommand, string> = {
  cite: '\\cite',
  citep: '\\citep (natbib)',
  citet: '\\citet (natbib)',
  parencite: '\\parencite (biblatex)',
  textcite: '\\textcite (biblatex)',
  autocite: '\\autocite (biblatex)',
};

export const CHANGE_LABEL: Record<BibChangeKind, string> = {
  'add-entry': 'New entry',
  'add-fields': 'Missing fields',
  unchanged: 'Already up to date',
  'key-collision': 'Key used by another entry',
  'existing-key-for-doi': 'Already in the file under another key',
  'missing-key': 'No citation key',
};

export const FINAL_JOB = new Set<ImportJob['status']>(['completed', 'failed', 'cancelled', 'interrupted']);
export const isActiveJob = (job: ImportJob) => !FINAL_JOB.has(job.status);

/** "3 added · 1 needs review · 1 failed" */
export function jobSummary(job: ImportJob): string {
  if (job.status === 'failed' && job.error) return job.error;
  if (job.status === 'interrupted') return 'Stopped when the runtime closed. Run the import again to finish it.';
  const counts = new Map<ImportItemOutcome, number>();
  for (const item of job.items) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
  const parts = [...counts].map(([outcome, n]) => `${n} ${OUTCOME_LABEL[outcome].toLowerCase()}`);
  if (job.status === 'cancelled') parts.push('cancelled');
  return parts.join(' · ') || (isActiveJob(job) ? 'Starting…' : 'Nothing to import');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function authorsShort(authors: string[], total: number): string {
  if (!authors.length) return 'Unknown authors';
  if (total <= 2) return authors.join(' and ');
  return `${authors[0]} et al.`;
}

export type ArchivedFilter = NonNullable<LibraryItemQuery['archived']>;
