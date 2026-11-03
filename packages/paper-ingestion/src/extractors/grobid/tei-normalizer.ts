import {
  classifySection,
  emptyMetadata,
  levelFromNumber,
  normalizeRotation,
  pageRange,
  spansText,
  splitHeadingNumber,
  type BlockType,
  type DocumentCoordinate,
  type ExtractedAuthor,
  type InlineSpan,
  type NormalizedBlock,
  type NormalizedDocument,
  type NormalizedElement,
  type NormalizedReference,
  type NormalizedSection,
  type PageGeometry,
  type SectionType,
} from '@research-studio/document-intelligence';
import { CoordinateNormalizer } from '../../normalization/coordinate-normalizer';
import { attachSentences, dedupeBlocks, emptyQuality, sectionPaths } from '../../normalization/structure-normalizer';
import type { ProcessingLimits } from '../../security/processing-limits';
import type { TeiBox, TeiDiv, TeiDocument, TeiItem } from './tei-parser';

const CONTEXT_TYPES: Record<string, SectionType> = {
  abstract: 'abstract',
  acknowledgement: 'acknowledgement',
  funding: 'acknowledgement',
  annex: 'appendix',
  availability: 'other',
  'author-contribution': 'other',
  'conflict-of-interest': 'other',
};

/**
 * TEI (already parsed) to the document model. `pages` is the page geometry
 * from PyMuPDF when it ran; GROBID's own page sizes are used otherwise.
 * GROBID's body divisions are flat, so nesting comes from printed heading
 * numbers ("2.1" sits under "2"); unnumbered headings are top level.
 */
export function normalizeTei(
  tei: TeiDocument,
  options: { pages: PageGeometry[]; extractorVersion: string | null; limits: Pick<ProcessingLimits, 'maxBlocks' | 'maxReferences' | 'maxElements'> },
): NormalizedDocument {
  const coords = new CoordinateNormalizer(options.pages, tei.surfaces);
  const box = (b: TeiBox[]) => coords.fromGrobid(b);
  const warnings: string[] = [];

  const pages: PageGeometry[] = options.pages.length
    ? options.pages
    : tei.surfaces.map((s) => ({ pageNumber: s.page, width: s.width, height: s.height, rotation: normalizeRotation(0), mediaBox: null, cropBox: null }));

  const sections: NormalizedSection[] = [];
  const blocks: NormalizedBlock[] = [];
  const elements: NormalizedElement[] = [];
  let truncated = false;

  const addBlock = (b: Omit<NormalizedBlock, 'key' | 'order' | 'pageStart' | 'pageEnd' | 'sentences' | 'sentenceSource'> & { teiSentences?: TeiItem['sentences'] }) => {
    if (blocks.length >= options.limits.maxBlocks) {
      truncated = true;
      return null;
    }
    const sentences = (b.teiSentences ?? []).map((s, i) => {
      const c = box(s.coords);
      return { order: i, text: s.text, coordinates: c, ...pageRange(c) };
    });
    const { teiSentences: _t, ...rest } = b;
    // Without boxes for the paragraph itself, its sentences' boxes are its area (they are real boxes, not estimates).
    const coordinates = b.coordinates.length ? b.coordinates : sentences.flatMap((s) => s.coordinates);
    const block: NormalizedBlock = {
      ...rest,
      coordinates,
      key: `b${blocks.length}`,
      order: blocks.length,
      ...pageRange(coordinates),
      sentences,
      sentenceSource: sentences.length ? 'extractor' : 'none',
    };
    blocks.push(block);
    return block;
  };

  // Title.
  if (tei.title) addBlock({ sectionKey: null, type: 'title', spans: [{ kind: 'text', text: tei.title }], plainText: tei.title, sourceId: null, coordinates: box(tei.titleCoords), elementKey: null });

  const addSection = (heading: string, number: string | null, level: number, type: SectionType, headCoords: DocumentCoordinate[]): NormalizedSection => {
    let parentKey: string | null = null;
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i]!.level < level) {
        parentKey = sections[i]!.key;
        break;
      }
    }
    const section: NormalizedSection = {
      key: `s${sections.length}`,
      parentKey,
      heading,
      number,
      level,
      order: sections.length,
      path: '',
      type,
      coordinates: headCoords,
      pageStart: null,
      pageEnd: null,
    };
    sections.push(section);
    return section;
  };

  const itemBlock = (item: TeiItem, sectionKey: string | null, sectionType: SectionType, context: string) => {
    const c = box(item.coords);
    if (item.kind === 'formula') {
      if (elements.length >= options.limits.maxElements) {
        truncated = true;
        return;
      }
      const content = spansText(item.spans) || null;
      const el: NormalizedElement = { key: `e${elements.length}`, type: 'equation', sectionKey, label: item.label, caption: null, content, sourceId: item.id, coordinates: c, ...pageRange(c) };
      elements.push(el);
      const text = [content, item.label].filter(Boolean).join(' ');
      addBlock({ sectionKey, type: 'display_formula', spans: [{ kind: 'formula', text: content ?? '' }, ...(item.label ? [{ kind: 'text' as const, text: ` ${item.label}` }] : [])], plainText: text, sourceId: item.id, coordinates: c, elementKey: el.key });
      return;
    }
    const type: BlockType =
      item.kind === 'list'
        ? 'list'
        : item.kind === 'note'
          ? 'footnote'
          : context === 'abstract'
            ? 'abstract'
            : sectionType === 'acknowledgement'
              ? 'acknowledgement'
              : 'paragraph';
    const plainText = item.kind === 'list' ? (item.spans[0]?.text ?? '') : spansText(item.spans);
    if (!plainText) return;
    addBlock({ sectionKey, type, spans: item.spans, plainText, sourceId: item.id, coordinates: c, elementKey: null, teiSentences: item.sentences });
  };

  const readDivs = (divs: TeiDiv[], defaultType: SectionType | null) => {
    const sectionForDiv: (string | null)[] = [];
    let current: NormalizedSection | null = null;
    for (const div of divs) {
      const contextType = CONTEXT_TYPES[div.context] ?? null;
      if (div.head) {
        const split = splitHeadingNumber(div.head);
        const number = div.headNumber?.replace(/\.$/, '') ?? split.number;
        const level = levelFromNumber(number) ?? (contextType === 'appendix' && current?.type === 'appendix' ? current.level + 1 : 1);
        const parentType = current && level > current.level ? current.type : null;
        const type = contextType ?? classifySection(div.head, parentType ?? defaultType);
        const headCoords = box(div.headCoords);
        current = addSection(div.headNumber && !split.number ? div.head : split.number ? split.text : div.head, number ?? null, level, type, headCoords);
        addBlock({ sectionKey: current.key, type: 'heading', spans: [{ kind: 'text', text: div.head }], plainText: div.head, sourceId: null, coordinates: headCoords, elementKey: null });
      } else if (contextType && (!current || current.type !== contextType)) {
        // An unheaded acknowledgement or annex division still gets its own (explicitly unnamed) section.
        current = addSection(contextType === 'acknowledgement' ? 'Acknowledgements' : contextType === 'appendix' ? 'Appendix' : 'Other', null, 1, contextType, []);
      }
      for (const item of div.items) itemBlock(item, current?.key ?? null, current?.type ?? defaultType ?? 'body', div.context);
      sectionForDiv.push(current?.key ?? null);
    }
    return sectionForDiv;
  };

  // Abstract.
  if (tei.abstract.some((d) => d.items.length)) {
    const s = addSection('Abstract', null, 1, 'abstract', []);
    for (const div of tei.abstract) for (const item of div.items) itemBlock(item, s.key, 'abstract', 'abstract');
  } else {
    warnings.push('No abstract was found.');
  }

  // Body, with figures and tables after the division they followed.
  const bodySections = readDivs(tei.body, null);
  const figureBlocks = (after: number) => {
    for (const f of tei.figures.filter((x) => x.afterDiv === after)) {
      if (elements.length >= options.limits.maxElements) {
        truncated = true;
        break;
      }
      const sectionKey = after >= 0 ? (bodySections[after] ?? null) : null;
      const c = box(f.coords);
      const caption = [f.head, f.description].filter(Boolean).join('. ') || null;
      const el: NormalizedElement = {
        key: `e${elements.length}`,
        type: f.type,
        sectionKey,
        label: f.label,
        caption,
        content: f.tableText,
        sourceId: f.id,
        coordinates: c,
        ...pageRange(c),
      };
      elements.push(el);
      if (caption) addBlock({ sectionKey, type: f.type === 'table' ? 'table_caption' : 'figure_caption', spans: [{ kind: 'text', text: caption }], plainText: caption, sourceId: f.id, coordinates: c, elementKey: el.key });
    }
  };
  // Blocks were added in body order; figures are appended per division to keep their section, then re-ordered below.
  for (let i = -1; i < tei.body.length; i++) figureBlocks(i);

  readDivs(tei.back, null);

  for (const note of tei.notes) itemBlock(note, null, 'other', 'note');

  // Bibliography.
  const references: NormalizedReference[] = [];
  if (tei.bibliography.length) {
    const refSection = addSection('References', null, 1, 'references', []);
    for (const b of tei.bibliography) {
      if (references.length >= options.limits.maxReferences) {
        truncated = true;
        break;
      }
      const c = box(b.coords);
      const ref: NormalizedReference = {
        key: `r${references.length}`,
        order: references.length,
        raw: b.raw,
        parsed: { title: b.title, authors: b.authors, venue: b.venue, year: b.year, volume: b.volume, pages: b.pages, publisher: b.publisher },
        doi: b.doi,
        arxivId: b.arxiv,
        sourceId: b.id,
        coordinates: c,
        ...pageRange(c),
      };
      references.push(ref);
      const text = b.raw ?? [b.authors.join(', '), b.title, b.venue, b.year].filter(Boolean).join('. ');
      if (text) addBlock({ sectionKey: refSection.key, type: 'reference', spans: [{ kind: 'text', text }], plainText: text, sourceId: b.id, coordinates: c, elementKey: null });
    }
  }

  if (truncated) warnings.push('The document has more structures than the processing limits allow; the rest were left out.');

  const orderedBlocks = reorderFigures(blocks, sections);
  const finalBlocks = attachSentences(dedupeBlocks(orderedBlocks, warnings));
  sectionPaths(sections, finalBlocks);

  const authors: ExtractedAuthor[] = tei.authors.map((a) => ({
    name: [a.forenames.join(' '), a.surname].filter(Boolean).join(' '),
    givenName: a.forenames.join(' ') || null,
    familyName: a.surname,
    email: a.email,
    affiliations: a.affiliations,
  }));

  const metadata = {
    ...emptyMetadata(),
    title: tei.title,
    authors,
    abstract: finalBlocks.filter((b) => b.type === 'abstract').map((b) => b.plainText).join('\n\n') || null,
    publicationDate: tei.date,
    doi: tei.doi,
    arxivId: tei.arxivId,
    keywords: tei.keywords,
    venue: tei.venue,
    language: tei.language,
  };
  if (!metadata.title) warnings.push('No title was found.');

  return {
    extractor: 'grobid',
    extractorVersion: options.extractorVersion ?? tei.grobidVersion,
    metadata,
    pages,
    sections,
    blocks: finalBlocks,
    elements,
    references,
    quality: emptyQuality('structured'),
    warnings: [...warnings, ...coords.warnings()],
  };
}

/** Put figure and table captions after the last block of their section (they were collected separately). */
function reorderFigures(blocks: NormalizedBlock[], sections: NormalizedSection[]): NormalizedBlock[] {
  const isCaption = (b: NormalizedBlock) => b.type === 'figure_caption' || b.type === 'table_caption';
  const captions = blocks.filter(isCaption);
  const rest = blocks.filter((b) => !isCaption(b));
  const sectionOrder = new Map(sections.map((s) => [s.key, s.order]));
  for (const cap of captions) {
    let at = -1;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i]!;
      if (b.sectionKey === cap.sectionKey) at = i;
      else if (cap.sectionKey && b.sectionKey && (sectionOrder.get(b.sectionKey) ?? 0) > (sectionOrder.get(cap.sectionKey) ?? 0)) break;
    }
    rest.splice(at + 1, 0, cap);
  }
  return rest.map((b, i) => ({ ...b, order: i }));
}

export type { InlineSpan };
