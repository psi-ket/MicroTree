import { stripComment } from '@research-studio/document-engine';
import type { CiteCommand } from '@research-studio/shared-types';

export type CitationSystem = 'natbib' | 'biblatex' | 'plain';

export interface CitationSetup {
  system: CitationSystem;
  /** Commands that compile with this setup. */
  commands: CiteCommand[];
  /** Parenthetical command to use when inserting after a claim. */
  parenthetical: CiteCommand;
}

/** Which citation commands the manuscript's preamble supports. Plain `\cite` always works. */
export function detectCitationSetup(preamble: string): CitationSetup {
  const code = preamble.split('\n').map(stripComment).join('\n');
  const biblatex = /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b[^}]*\}/.exec(code);
  if (biblatex) {
    const natbibCompat = /natbib\s*(=\s*true)?/.test(biblatex[1] ?? '');
    return { system: 'biblatex', commands: ['cite', 'parencite', 'textcite', 'autocite', ...(natbibCompat ? (['citep', 'citet'] as const) : [])], parenthetical: 'autocite' };
  }
  if (/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bnatbib\b[^}]*\}/.test(code)) return { system: 'natbib', commands: ['cite', 'citep', 'citet'], parenthetical: 'citep' };
  return { system: 'plain', commands: ['cite'], parenthetical: 'cite' };
}

const TEXTUAL: ReadonlySet<CiteCommand> = new Set(['citet', 'textcite']);

/**
 * The command to insert: the project's configured one if the preamble
 * supports it (a textual command only where a name is placed in the text);
 * otherwise the setup's parenthetical command, with a warning.
 */
export function chooseCommand(configured: CiteCommand, setup: CitationSetup, textual = false): { command: CiteCommand; warning: string | null } {
  if (!setup.commands.includes(configured)) {
    return { command: setup.parenthetical, warning: `\\${configured} is not available with this preamble (${setup.system}); \\${setup.parenthetical} is used instead.` };
  }
  if (TEXTUAL.has(configured) && !textual) {
    const alt = setup.system === 'biblatex' ? 'autocite' : setup.system === 'natbib' ? 'citep' : 'cite';
    return { command: alt, warning: `\\${configured} prints the authors' names in the text; at the end of a claim \\${alt} is used instead.` };
  }
  return { command: configured, warning: null };
}

export interface InsertionCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Checks before a citation is inserted: the paper is in the library, the key
 * is valid and not taken by a different work, and the sentence does not
 * already cite it. A missing `.bib` entry is not a problem when a reviewed
 * `.bib` change will add it.
 */
export function validateInsertion(input: { inLibrary: boolean; key: string; keyValid: string | null; collision: boolean; alreadyCited: boolean; bibEntryExists: boolean; bibChangePlanned: boolean }): InsertionCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!input.inLibrary) problems.push('The paper is not in the library; add it before citing it.');
  if (input.keyValid) problems.push(`The citation key "${input.key}" is not valid: ${input.keyValid}`);
  if (input.collision) problems.push(`The key "${input.key}" is already used in the bibliography for a different work.`);
  if (input.alreadyCited) warnings.push(`The sentence already cites ${input.key}.`);
  if (!input.bibEntryExists && !input.bibChangePlanned) problems.push(`No bibliography entry for ${input.key}, and none can be added.`);
  return { ok: problems.length === 0, problems, warnings };
}
