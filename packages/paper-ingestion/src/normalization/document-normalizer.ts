import { normalizeSearchText, type ExtractionQuality, type ExtractionStatus, type NormalizedDocument } from '@research-studio/document-intelligence';

function words(text: string): Set<string> {
  return new Set(normalizeSearchText(text).match(/\p{L}{3,}/gu) ?? []);
}

/**
 * Quality indicators for an extraction. `textCoverage` compares the words of
 * the normalised document with the words of the PDF's text layer (PyMuPDF):
 * a structured extraction that lost text shows it here.
 */
export function measureQuality(doc: NormalizedDocument, pdfPageTexts: string[] | null): ExtractionQuality {
  const paragraphs = doc.blocks.filter((b) => b.type === 'paragraph' || b.type === 'abstract');
  const withBoxes = doc.blocks.filter((b) => b.coordinates.length).length;
  let textCoverage: number | null = null;
  if (pdfPageTexts) {
    const pdfWords = words(pdfPageTexts.join('\n'));
    if (pdfWords.size) {
      const docWords = words(doc.blocks.map((b) => b.plainText).join('\n') + '\n' + doc.elements.map((e) => `${e.caption ?? ''} ${e.content ?? ''}`).join('\n'));
      let found = 0;
      for (const w of pdfWords) if (docWords.has(w)) found++;
      textCoverage = Math.round((found / pdfWords.size) * 1000) / 1000;
    }
  }
  return {
    textCoverage,
    hasTitle: !!doc.metadata.title,
    hasAbstract: !!doc.metadata.abstract,
    sectionCount: doc.sections.filter((s) => s.type !== 'references' && s.type !== 'abstract').length,
    paragraphCount: paragraphs.length,
    referenceCount: doc.references.length,
    coordinateCoverage: doc.blocks.length ? Math.round((withBoxes / doc.blocks.length) * 1000) / 1000 : 0,
    emptyPages: pdfPageTexts ? pdfPageTexts.flatMap((t, i) => (t.trim() ? [] : [i + 1])) : [],
    structure: doc.quality.structure,
  };
}

/** Minimum share of the PDF's words a structured extraction must contain to count as complete. */
export const MIN_COVERAGE = 0.6;

/** A structured extraction is useful when it has body text. */
export function hasUsableBody(doc: NormalizedDocument): boolean {
  const chars = doc.blocks.filter((b) => b.type === 'paragraph' || b.type === 'abstract' || b.type === 'list').reduce((n, b) => n + b.plainText.length, 0);
  return chars >= 200;
}

/**
 * `completed` for a structured extraction that kept most of the text;
 * `partial` for the layout fallback, low coverage, truncation or a missing body.
 */
export function extractionStatus(doc: NormalizedDocument): Extract<ExtractionStatus, 'completed' | 'partial'> {
  if (doc.quality.structure === 'layout') return 'partial';
  if (doc.quality.textCoverage !== null && doc.quality.textCoverage < MIN_COVERAGE) return 'partial';
  if (!hasUsableBody(doc)) return 'partial';
  if (doc.warnings.some((w) => w.includes('processing limits'))) return 'partial';
  return 'completed';
}

/** Add quality and coverage warnings; returns the document with its quality set. */
export function finalizeDocument(doc: NormalizedDocument, pdfPageTexts: string[] | null): NormalizedDocument {
  const quality = measureQuality(doc, pdfPageTexts);
  const warnings = [...doc.warnings];
  if (quality.textCoverage !== null && quality.textCoverage < MIN_COVERAGE) {
    warnings.push(`Only ${Math.round(quality.textCoverage * 100)}% of the words in the PDF's text layer were found in the extracted text.`);
  }
  if (quality.emptyPages.length) warnings.push(`Pages without a text layer: ${quality.emptyPages.slice(0, 20).join(', ')}${quality.emptyPages.length > 20 ? ', …' : ''}.`);
  if (!quality.referenceCount) warnings.push('No bibliography was found.');
  return { ...doc, quality, warnings };
}
