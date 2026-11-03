import type { DocumentJobStatus } from '@research-studio/document-intelligence';

/** Stages in the order a job passes through them. */
export const PIPELINE_STAGES: readonly DocumentJobStatus[] = [
  'queued',
  'validating',
  'extracting',
  'normalizing',
  'segmenting',
  'indexing_keywords',
  'generating_embeddings',
  'indexing_vectors',
];

export const STAGE_LABEL: Record<DocumentJobStatus, string> = {
  queued: 'Waiting',
  validating: 'Checking the PDF',
  extracting: 'Extracting the structure',
  normalizing: 'Normalising',
  segmenting: 'Splitting into passages',
  indexing_keywords: 'Building the keyword index',
  generating_embeddings: 'Computing embeddings',
  indexing_vectors: 'Storing vectors',
  completed: 'Done',
  partial: 'Done, with gaps',
  needs_ocr: 'Needs OCR',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Overall progress (0..1) from the stage and the stage's own progress. */
export function overallProgress(status: DocumentJobStatus, stageProgress: number | null): number {
  const i = PIPELINE_STAGES.indexOf(status);
  if (i === -1) return 1;
  const within = stageProgress === null ? 0 : Math.min(1, Math.max(0, stageProgress));
  return Math.round(((i + within) / PIPELINE_STAGES.length) * 1000) / 1000;
}
