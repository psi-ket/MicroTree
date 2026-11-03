import type { FileKind } from '@research-studio/shared-types';
import { extname } from './paths';

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  tex: 'tex',
  ltx: 'tex',
  bib: 'bib',
  cls: 'cls',
  sty: 'sty',
  bst: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  eps: 'image',
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  yaml: 'text',
  yml: 'text',
  dat: 'text',
  tikz: 'tex',
  pgf: 'tex',
};

export function classifyFile(path: string): FileKind {
  return KIND_BY_EXTENSION[extname(path)] ?? 'other';
}

/** Kinds whose content can be opened in the text editor. */
export function isTextKind(kind: FileKind): boolean {
  return kind === 'tex' || kind === 'bib' || kind === 'cls' || kind === 'sty' || kind === 'text';
}

/** Extensions a client may create as text documents. */
export const EDITABLE_EXTENSIONS = [
  'tex',
  'ltx',
  'bib',
  'cls',
  'sty',
  'bst',
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'dat',
  'tikz',
  'pgf',
] as const;

export function isEditablePath(path: string): boolean {
  return (EDITABLE_EXTENSIONS as readonly string[]).includes(extname(path));
}

export function editorLanguageFor(path: string): string {
  switch (classifyFile(path)) {
    case 'tex':
    case 'cls':
    case 'sty':
      return 'latex';
    case 'bib':
      return 'bibtex';
    default: {
      const ext = extname(path);
      if (ext === 'json') return 'json';
      if (ext === 'md') return 'markdown';
      if (ext === 'yaml' || ext === 'yml') return 'yaml';
      return 'plaintext';
    }
  }
}
