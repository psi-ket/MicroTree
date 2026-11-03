/**
 * Record shapes for sentence-level evidence and citation verification
 * (future milestone). Types only.
 */
import type { SourceLocation } from './domain';

export type EvidenceVerdict =
  | 'supported'
  | 'partially-supported'
  | 'unsupported'
  | 'contradicted'
  | 'unverified';

export interface ClaimSpan {
  file: string;
  from: SourceLocation;
  to: SourceLocation;
  text: string;
  citeKeys: string[];
}

export interface EvidenceLink {
  citeKey: string;
  /** DOI, arXiv id, or URL of the cited work. */
  identifier: string | null;
  quote: string | null;
  verdict: EvidenceVerdict;
  rationale: string | null;
}

export interface ClaimVerification {
  claim: ClaimSpan;
  evidence: EvidenceLink[];
  checkedAt: string;
}
