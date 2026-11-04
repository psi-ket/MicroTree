import { computeCoverage, type ClaimForCoverage, type Coverage } from './coverage-analysis';

export interface SectionSummary {
  sectionPath: string;
  coverage: Coverage;
  /** Claims that need evidence and have no citation in the text (whatever evidence was found). */
  missingCitations: string[];
  conflicts: string[];
  /** Distinct works supporting claims in the section, and supporting links in total. */
  sourceDiversity: { works: number; links: number };
}

/** Per-section summaries (claims grouped by their section path). */
export function summariseSections(claims: readonly (ClaimForCoverage & { cited: boolean })[]): SectionSummary[] {
  const by = new Map<string, (ClaimForCoverage & { cited: boolean })[]>();
  for (const c of claims) by.set(c.sectionPath || '(no section)', [...(by.get(c.sectionPath || '(no section)') ?? []), c]);
  return [...by.entries()].map(([sectionPath, cs]) => {
    const live = cs.filter((c) => c.reviewState !== 'archived' && c.reviewState !== 'excluded');
    const works = new Set(live.flatMap((c) => c.supportingWorkIds));
    return {
      sectionPath,
      coverage: computeCoverage(cs),
      missingCitations: live.filter((c) => c.requiresEvidence && !c.cited).map((c) => c.id),
      conflicts: live.filter((c) => c.status === 'potentially_contradicted').map((c) => c.id),
      sourceDiversity: { works: works.size, links: live.reduce((n, c) => n + c.supportingWorkIds.length, 0) },
    };
  });
}
