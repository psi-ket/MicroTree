import type { ScholarlyAuthor, ScholarlyWork } from '@research-studio/shared-types';

/** Only http(s) links are ever rendered as links; anything else (javascript:, data:, file:) is dropped. */
export function safeExternalUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split('-')
        .map((p) => `${p[0]!.toUpperCase()}.`)
        .join('-'),
    )
    .join(' ');
}

function citationName(a: ScholarlyAuthor): string {
  if (a.familyName && a.givenName) return `${a.familyName}, ${initials(a.givenName)}`;
  return a.familyName ?? a.name;
}

function authorList(authors: ScholarlyAuthor[]): string {
  const names = authors.map(citationName);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  // More than 20 authors: first 19, an ellipsis, then the last (APA 7).
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, … ${names.at(-1)}`;
  return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`;
}

const endWithPeriod = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

/**
 * A plain-text reference in an author–date style close to APA 7:
 * `Shor, P. W. (1995). Title. Journal, 52(4), R2493. https://doi.org/…`.
 * For copying into notes; LaTeX documents should use the BibTeX entry.
 */
export function formatCitation(work: ScholarlyWork): string {
  const parts: string[] = [];
  const authors = authorList(work.authors);
  const year = work.publicationYear !== null ? `(${work.publicationYear})` : '(n.d.)';
  parts.push(authors ? `${endWithPeriod(authors)} ${year}.` : `${endWithPeriod(work.title)} ${year}.`);
  if (authors) parts.push(endWithPeriod(work.title));

  if (work.venue) {
    let source = work.venue;
    const { volume, issue, pages } = work.bibliographic;
    if (volume) source += `, ${volume}${issue ? `(${issue})` : ''}`;
    if (pages) source += `, ${pages.replace(/\s*-+\s*/g, '–')}`;
    parts.push(endWithPeriod(source));
  } else if (work.identifiers.arxivId) {
    parts.push(`arXiv preprint arXiv:${work.identifiers.arxivId}.`);
  }

  const link = work.identifiers.doi ? `https://doi.org/${work.identifiers.doi}` : safeExternalUrl(work.urls.abstract ?? work.urls.landingPage);
  if (link) parts.push(link);
  return parts.join(' ');
}
