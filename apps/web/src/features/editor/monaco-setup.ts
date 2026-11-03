import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import type { CiteSymbol, LabelSymbol } from '@research-studio/api-contracts';
import {
  BIBTEX_ENTRY_TYPES,
  bibtexEntrySnippet,
  detectCompletionContext,
  extname,
  LATEX_COMMANDS,
  LATEX_ENVIRONMENTS,
  openEnvironments,
} from '@research-studio/document-engine';
import { bibtexConfiguration, bibtexLanguage, editorThemes, latexConfiguration, latexLanguage } from './languages';

// Bundle Monaco locally (no CDN): the app must work fully offline.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco });

/** Project-wide symbols for completion; updated by the workspace. */
export const completionSources: {
  labels: LabelSymbol[];
  citations: CiteSymbol[];
  files: string[];
} = { labels: [], citations: [], files: [] };

const GRAPHIC_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps', 'gif', 'svg', 'webp']);

let initialised = false;

export function setupMonaco(): typeof monaco {
  if (initialised) return monaco;
  initialised = true;

  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls', '.ltx'], aliases: ['LaTeX'] });
  monaco.languages.setMonarchTokensProvider('latex', latexLanguage);
  monaco.languages.setLanguageConfiguration('latex', latexConfiguration);
  monaco.languages.register({ id: 'bibtex', extensions: ['.bib'], aliases: ['BibTeX'] });
  monaco.languages.setMonarchTokensProvider('bibtex', bibtexLanguage);
  monaco.languages.setLanguageConfiguration('bibtex', bibtexConfiguration);
  for (const [name, theme] of Object.entries(editorThemes)) monaco.editor.defineTheme(name, theme);

  const { CompletionItemKind: Kind, CompletionItemInsertTextRule: Rule } = monaco.languages;

  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\', '{', ',', '/'],
    provideCompletionItems(model, position) {
      const before = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const ctx = detectCompletionContext(before);
      if (!ctx) return { suggestions: [] };
      const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
      const range = new monaco.Range(position.lineNumber, ctx.start + 1, position.lineNumber, position.column);

      switch (ctx.kind) {
        case 'command':
          return {
            suggestions: LATEX_COMMANDS.map((c) => ({
              label: `\\${c.name}`,
              filterText: c.name,
              kind: Kind.Function,
              detail: c.package ? `${c.detail} · ${c.package}` : c.detail,
              insertText: c.snippet,
              insertTextRules: Rule.InsertAsSnippet,
              range,
            })),
          };
        case 'begin': {
          // Replace an auto-closed `}` if present, and add the matching \end.
          const closing = after.startsWith('}') ? 1 : 0;
          const r = new monaco.Range(position.lineNumber, ctx.start + 1, position.lineNumber, position.column + closing);
          return {
            suggestions: LATEX_ENVIRONMENTS.map((env) => ({
              label: env.name,
              kind: Kind.Module,
              detail: env.package ? `${env.detail} · ${env.package}` : env.detail,
              insertText: `${env.name}}\n${env.body}\n\\end{${env.name}}`,
              insertTextRules: Rule.InsertAsSnippet,
              range: r,
            })),
          };
        }
        case 'end': {
          const text = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const open = openEnvironments(text).reverse();
          return {
            suggestions: open.map((name, i) => ({
              label: name,
              kind: Kind.Module,
              detail: i === 0 ? 'Innermost open environment' : 'Open environment',
              insertText: after.startsWith('}') ? name : `${name}}`,
              sortText: String(i).padStart(3, '0'),
              range,
            })),
          };
        }
        case 'ref':
          return {
            suggestions: completionSources.labels.map((l) => ({
              label: l.label,
              kind: Kind.Reference,
              detail: `${l.file}:${l.line}`,
              insertText: l.label,
              range,
            })),
          };
        case 'cite':
          return {
            suggestions: completionSources.citations.map((c) => ({
              label: c.key,
              kind: Kind.Value,
              detail: [c.author?.split(' and ')[0], c.year].filter(Boolean).join(', '),
              documentation: c.title ?? undefined,
              filterText: `${c.key} ${c.title ?? ''} ${c.author ?? ''}`,
              insertText: c.key,
              range,
            })),
          };
        case 'input':
          return {
            suggestions: completionSources.files
              .filter((f) => extname(f) === 'tex')
              .map((f) => ({ label: f.replace(/\.tex$/, ''), kind: Kind.File, insertText: f.replace(/\.tex$/, ''), range })),
          };
        case 'graphics':
          return {
            suggestions: completionSources.files
              .filter((f) => GRAPHIC_EXTENSIONS.has(extname(f)))
              .map((f) => ({ label: f, kind: Kind.File, insertText: f, range })),
          };
        case 'bibliography':
          return {
            suggestions: completionSources.files
              .filter((f) => extname(f) === 'bib')
              .map((f) => ({ label: f.replace(/\.bib$/, ''), kind: Kind.File, insertText: f.replace(/\.bib$/, ''), range })),
          };
      }
      return { suggestions: [] };
    },
  });

  monaco.languages.registerCompletionItemProvider('bibtex', {
    triggerCharacters: ['@'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = /@([a-zA-Z]*)$/.exec(before);
      if (!m) return { suggestions: [] };
      const range = new monaco.Range(position.lineNumber, position.column - m[0].length, position.lineNumber, position.column);
      return {
        suggestions: BIBTEX_ENTRY_TYPES.map((type) => ({
          label: `@${type}`,
          kind: Kind.Struct,
          insertText: bibtexEntrySnippet(type),
          insertTextRules: Rule.InsertAsSnippet,
          range,
        })),
      };
    },
  });

  return monaco;
}

export { monaco };
