import type { ScholarlySourceRecord } from '@research-studio/shared-types';
import { identifierKeys, identitiesCompatible, identityOf } from './identifier-matching';
import { sameWorkByMetadata } from './title-matching';

/**
 * Group records that describe the same work. Matching, in order:
 * 1. normalised DOI (arXiv DOIs excluded), 2. arXiv identifier (versions
 * ignored), 3. stable provider IDs (OpenAlex, Semantic Scholar, PubMed),
 * 4. title + authors + year, validated by `sameWorkByMetadata`.
 * A merge is refused whenever the result would hold two different DOIs or two
 * different arXiv identifiers. Exact duplicates (same provider and record ID)
 * collapse into one. Output order follows first appearance in the input.
 */
export function deduplicate(input: ScholarlySourceRecord[]): ScholarlySourceRecord[][] {
  const seen = new Map<string, number>();
  const records: ScholarlySourceRecord[] = [];
  for (const r of input) {
    const key = `${r.provider}:${r.providerId}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, records.length);
      records.push(r);
    } else if (r.retrievedAt > records[at]!.retrievedAt) {
      records[at] = r;
    }
  }

  const parent = records.map((_, i) => i);
  const members = records.map((r) => [r]);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return true;
    if (!identitiesCompatible(identityOf(members[ra]!), identityOf(members[rb]!))) return false;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent[drop] = keep;
    members[keep] = [...members[keep]!, ...members[drop]!];
    members[drop] = [];
    return true;
  };

  const byKey = new Map<string, number>();
  records.forEach((r, i) => {
    for (const key of identifierKeys(r)) {
      const other = byKey.get(key);
      if (other === undefined) byKey.set(key, i);
      else union(other, i);
    }
  });

  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (find(i) === find(j)) continue;
      if (sameWorkByMetadata(records[i]!, records[j]!)) union(i, j);
    }
  }

  const groups: ScholarlySourceRecord[][] = [];
  records.forEach((_, i) => {
    if (find(i) === i) groups.push(members[i]!);
  });
  return groups;
}
