import type { LiteratureProviderId, ScholarlyAuthor } from '@research-studio/shared-types';
import { normalizeOrcid } from './identifier-normalizer';
import { cleanText } from './work-normalizer';

export interface AuthorInput {
  name?: string | null;
  given?: string | null;
  family?: string | null;
  orcid?: string | null;
  affiliations?: (string | null | undefined)[];
  provider?: LiteratureProviderId;
  providerId?: string | null;
}

/**
 * Build an author from what a provider supplied. Given and family names are
 * only filled when the provider gave them separately; a display name is never
 * split into parts.
 */
export function normalizeAuthor(input: AuthorInput): ScholarlyAuthor | null {
  const given = cleanText(input.given);
  const family = cleanText(input.family);
  const name = cleanText(input.name) ?? cleanText([given, family].filter(Boolean).join(' '));
  if (!name) return null;
  const providerIds: ScholarlyAuthor['providerIds'] = {};
  if (input.provider && input.providerId) providerIds[input.provider] = input.providerId;
  return {
    name,
    givenName: given,
    familyName: family,
    orcid: normalizeOrcid(input.orcid),
    affiliations: [...new Set((input.affiliations ?? []).map((a) => cleanText(a)).filter((a): a is string => a !== null))],
    providerIds,
  };
}

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'dos', 'das', 'ter', 'ten', 'bin', 'al']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/**
 * A comparison key for an author's family name, used only for matching
 * records (never displayed). Prefers the provider's family name; otherwise
 * `Family, Given` or the last word of `Given Family`, skipping suffixes.
 */
export function familyKey(author: Pick<ScholarlyAuthor, 'name' | 'familyName'>): string | null {
  if (author.familyName) return fold(author.familyName).replace(/[\s'-]/g, '') || null;
  const name = author.name.trim();
  if (name.includes(',')) return fold(name.split(',')[0]!).replace(/[\s'-]/g, '') || null;
  const words = fold(name).split(' ').filter((w) => w && !SUFFIXES.has(w.replace(/\./g, '')));
  if (!words.length) return null;
  let i = words.length - 1;
  const parts = [words[i]!];
  while (i > 1 && PARTICLES.has(words[i - 1]!)) parts.unshift(words[--i]!);
  return parts.join('').replace(/['-]/g, '') || null;
}

/** All name words, folded, for matching a free-text author query. */
export function nameTokens(author: Pick<ScholarlyAuthor, 'name'>): string[] {
  return fold(author.name).split(/[\s-]+/).filter((w) => w.length > 1);
}
