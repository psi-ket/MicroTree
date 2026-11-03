import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// The worker is bundled with the app (no CDN).
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js 6 no longer compiles PDF functions with eval; the production CSP
// (no 'unsafe-eval') enforces that regardless.
export async function loadPdf(data: ArrayBuffer): Promise<pdfjs.PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(data), enableXfa: false }).promise;
}

export function destroyPdf(doc: pdfjs.PDFDocumentProxy | null | undefined): void {
  void doc?.loadingTask.destroy();
}

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
