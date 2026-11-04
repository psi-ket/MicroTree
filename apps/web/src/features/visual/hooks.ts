import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { runtime } from '../../lib/connection';
import { destroyPdf, loadPdf, type PDFDocumentProxy } from '../pdf/pdfjs';

/** An object URL for a stored image (the runtime serves SVG only as its sanitised raster). */
export function useAssetUrl(assetId: string | null): string | null {
  const blob = useQuery({ queryKey: ['visual', 'asset-content', assetId], queryFn: ({ signal }) => runtime().visual.assetContent(assetId!, signal), enabled: !!assetId, staleTime: Infinity });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob.data]);
  return url;
}

/** The compiled preview of one version, loaded into pdf.js. */
export function usePreviewPdf(artifactId: string | null, version: number | null, available: boolean): { doc: PDFDocumentProxy | null; error: string | null } {
  const bytes = useQuery({
    queryKey: ['visual', 'preview', artifactId, version],
    queryFn: ({ signal }) => runtime().visual.preview(artifactId!, version!, signal),
    enabled: !!artifactId && !!version && available,
    staleTime: Infinity,
  });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes.data) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    loadPdf(bytes.data.slice(0))
      .then((d) => {
        loaded = d;
        if (cancelled) destroyPdf(d);
        else setDoc(d);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      destroyPdf(loaded);
    };
  }, [bytes.data]);
  return { doc, error: error ?? (bytes.error ? String(bytes.error) : null) };
}
