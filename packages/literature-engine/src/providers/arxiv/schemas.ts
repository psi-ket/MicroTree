import { z } from 'zod';
import { childElements, firstChild, textOf, type XmlElement } from './xml';

/**
 * arXiv returns Atom XML (https://info.arxiv.org/help/api/user-manual.html).
 * The feed is first read into plain objects, then validated with Zod like the
 * JSON providers.
 */

export const ArxivEntry = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string().nullable(),
  published: z.string().nullable(),
  updated: z.string().nullable(),
  authors: z.array(z.object({ name: z.string(), affiliations: z.array(z.string()) })),
  links: z.array(z.object({ href: z.string(), rel: z.string().nullable(), title: z.string().nullable(), type: z.string().nullable() })),
  categories: z.array(z.string()),
  primaryCategory: z.string().nullable(),
  comment: z.string().nullable(),
  journalRef: z.string().nullable(),
  doi: z.string().nullable(),
});
export type ArxivEntry = z.infer<typeof ArxivEntry>;

export interface ArxivFeed {
  totalResults: number | null;
  startIndex: number | null;
  entries: unknown[];
  /** Message of an error entry (arXiv reports errors as a feed with one entry). */
  error: string | null;
}

const opt = (el: XmlElement | null) => (el ? textOf(el) : null);

export function readFeed(root: XmlElement): ArxivFeed {
  if (root.name !== 'feed') throw new Error('Not an Atom feed');
  const num = (name: string) => {
    const v = Number(textOf(firstChild(root, name)));
    return Number.isFinite(v) && textOf(firstChild(root, name)).trim() !== '' ? v : null;
  };
  const entries = childElements(root, 'entry');
  const first = entries[0];
  const firstId = first ? textOf(firstChild(first, 'id')) : '';
  if (first && /\/api\/errors/.test(firstId)) {
    return { totalResults: 0, startIndex: 0, entries: [], error: textOf(firstChild(first, 'summary')).trim() || 'arXiv rejected the query' };
  }
  return {
    totalResults: num('opensearch:totalResults'),
    startIndex: num('opensearch:startIndex'),
    entries: entries.map((e) => ({
      id: textOf(firstChild(e, 'id')).trim(),
      title: textOf(firstChild(e, 'title')),
      summary: opt(firstChild(e, 'summary')),
      published: opt(firstChild(e, 'published')),
      updated: opt(firstChild(e, 'updated')),
      authors: childElements(e, 'author').map((a) => ({
        name: textOf(firstChild(a, 'name')),
        affiliations: childElements(a, 'arxiv:affiliation').map((x) => textOf(x)),
      })),
      links: childElements(e, 'link').map((l) => ({
        href: l.attributes.href ?? '',
        rel: l.attributes.rel ?? null,
        title: l.attributes.title ?? null,
        type: l.attributes.type ?? null,
      })),
      categories: childElements(e, 'category').map((c) => c.attributes.term ?? '').filter(Boolean),
      primaryCategory: firstChild(e, 'arxiv:primary_category')?.attributes.term ?? null,
      comment: opt(firstChild(e, 'arxiv:comment')),
      journalRef: opt(firstChild(e, 'arxiv:journal_ref')),
      doi: opt(firstChild(e, 'arxiv:doi')),
    })),
    error: null,
  };
}
