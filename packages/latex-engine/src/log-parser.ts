import type { Diagnostic } from '@research-studio/shared-types';

/**
 * Parsers for TeX, BibTeX and biber logs. The TeX parser assumes logs were
 * produced with `-file-line-error` and `max_print_line=10000` (see
 * `TEX_SECURITY_ENV`), so messages are not hard-wrapped at 79 columns.
 */

/** Maps a raw file name from a log to a project-relative path, or null for files outside the project. */
export type FileResolver = (raw: string) => string | null;

const FILE_LINE_ERROR = /^((?:[A-Za-z]:)?[^:]*?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const WARNING_START =
  /^(LaTeX(?: Font)?|Package ([^\s]+)|Class ([^\s]+)|pdfTeX) (Warning|warning): (.*)$/;
const BOX_WARNING = /^(Over|Under)full \\[hv]box \((.*?)\)(?: in paragraph| detected| has occurred)?.*?(?:at lines? (\d+)(?:--\d+)?)?$/;
const INPUT_LINE = /on input line (\d+)/;
const FATAL = /^==> Fatal error occurred/;
const NOISE_WARNINGS = [
  /^There were undefined references\.?$/,
  /^There were multiply-defined labels\.?$/,
  /^Label\(s\) may have changed\. Rerun to get cross-references right\.?$/,
  /^Citation\(s\) may have changed\./,
];

/** Expected consequences of the hardened toolchain; reported as info rather than warnings. */
const EXPECTED_WARNINGS = [/^epstopdf: Shell escape feature is not enabled\.?$/];

function looksLikeFileToken(token: string): boolean {
  if (token.length === 0) return false;
  if (/^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(token)) return true;
  return /^[^\s,;`']+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token);
}

/**
 * Tracks which file TeX is currently reading by following the `(file` / `)`
 * markers TeX writes to the log. Non-file parentheses are pushed as `null`
 * so that ordinary parenthesised text stays balanced.
 */
class FileStack {
  private readonly stack: (string | null)[] = [];

  current(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i];
      if (entry) return entry;
    }
    return null;
  }

  consume(line: string): void {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        let token: string;
        if (line[i + 1] === '"') {
          const end = line.indexOf('"', i + 2);
          token = end === -1 ? '' : line.slice(i + 2, end);
          if (end !== -1) i = end;
        } else {
          const match = /^[^\s()[\]{}<>"]+/.exec(line.slice(i + 1));
          token = match ? match[0] : '';
          i += token.length;
        }
        this.stack.push(looksLikeFileToken(token) ? token : null);
      } else if (ch === ')') {
        this.stack.pop();
      }
    }
  }
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.severity}|${d.source}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseLatexLog(log: string, resolve: FileResolver): Diagnostic[] {
  const lines = log.split(/\r?\n/);
  const files = new FileStack();
  const out: Diagnostic[] = [];
  const currentFile = () => {
    const raw = files.current();
    return raw ? resolve(raw) : null;
  };

  /** Collect the `l.<n> ...` context that follows an error message. */
  const readContext = (start: number): { end: number; line: number | null; context: string | null } => {
    for (let j = start; j < Math.min(lines.length, start + 25); j++) {
      const m = /^l\.(\d+) ?(.*)$/.exec(lines[j]!);
      if (m) {
        const after = (lines[j + 1] ?? '').trim();
        const context = [`l.${m[1]} ${m[2]!}`.trimEnd(), after].filter(Boolean).join(' ⟨…⟩ ');
        return { end: j + 1, line: Number(m[1]), context };
      }
      if (lines[j]!.startsWith('! ') || FILE_LINE_ERROR.test(lines[j]!)) break;
    }
    return { end: start, line: null, context: null };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && looksLikeFileToken(fle[1]!)) {
      const message = fle[3]!.trim();
      const ctx = readContext(i + 1);
      i = Math.max(i, ctx.end);
      if (FATAL.test(message)) continue;
      const previous = out[out.length - 1];
      if (message === 'Emergency stop.' && previous?.severity === 'error' && previous.line === null) {
        // `! File ... not found.` errors carry no location; the emergency stop that follows does.
        previous.file ??= resolve(fle[1]!);
        previous.line = Number(fle[2]);
        previous.context ??= ctx.context;
        continue;
      }
      out.push({
        severity: 'error',
        source: 'latex',
        message,
        file: resolve(fle[1]!),
        line: Number(fle[2]),
        context: ctx.context,
      });
      continue;
    }

    if (line.startsWith('! ')) {
      const ctx = readContext(i + 1);
      const message = line.slice(2).trim();
      if (!FATAL.test(message)) {
        out.push({
          severity: 'error',
          source: 'latex',
          message,
          file: currentFile(),
          line: ctx.line,
          context: ctx.context,
        });
      }
      i = Math.max(i, ctx.end);
      continue;
    }

    const warn = WARNING_START.exec(line);
    if (warn) {
      const pkg = warn[2] ?? warn[3];
      const parts = [warn[5]!.trim()];
      // Continuation lines: `(pkg)   text` for packages, indented text otherwise.
      let j = i + 1;
      for (; j < lines.length && j < i + 8; j++) {
        const next = lines[j]!;
        if (pkg && next.startsWith(`(${pkg})`)) parts.push(next.slice(pkg.length + 2).trim());
        else if (/^\s{2,}\S/.test(next) && !pkg) parts.push(next.trim());
        else break;
      }
      const message = parts.join(' ');
      const fullMessage = pkg ? `${pkg}: ${message}` : message;
      if (!NOISE_WARNINGS.some((re) => re.test(message))) {
        const lineMatch = INPUT_LINE.exec(message);
        out.push({
          severity: warn[1] === 'LaTeX Font' || EXPECTED_WARNINGS.some((re) => re.test(fullMessage)) ? 'info' : 'warning',
          source: 'latex',
          message: fullMessage,
          file: currentFile(),
          line: lineMatch ? Number(lineMatch[1]) : null,
          context: null,
        });
      }
      i = j - 1;
      continue;
    }

    const box = BOX_WARNING.exec(line);
    if (box) {
      out.push({
        severity: 'info',
        source: 'latex',
        message: line.replace(/\s+in paragraph at lines.*$/, '').trim(),
        file: currentFile(),
        line: box[3] ? Number(box[3]) : null,
        context: null,
      });
    }

    files.consume(line);
  }

  return dedupe(out);
}

/** Parse a BibTeX `.blg` file. */
export function parseBibtexLog(blg: string, resolve: FileResolver): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = blg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^Warning--(.*)$/.exec(line))) {
      const loc = /^--line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '');
      out.push({
        severity: 'warning',
        source: 'bibtex',
        message: m[1]!.trim(),
        file: loc ? resolve(loc[2]!.trim()) : null,
        line: loc ? Number(loc[1]) : null,
        context: null,
      });
      if (loc) i++;
    } else if ((m = /^(.*?)---line (\d+) of file (.+)$/.exec(line))) {
      const contextLines: string[] = [];
      for (let j = i + 1; j < lines.length && lines[j]!.startsWith(' : '); j++) {
        contextLines.push(lines[j]!.slice(3));
      }
      out.push({
        severity: 'error',
        source: 'bibtex',
        message: m[1]!.trim() || 'Syntax error',
        file: resolve(m[3]!.trim()),
        line: Number(m[2]),
        context: contextLines.length ? contextLines.join(' ') : null,
      });
    } else if (
      (m = /^(I couldn't open (?:database|style|auxiliary) file .*|I found no \\\w+ commands?.*)$/.exec(line))
    ) {
      out.push({
        // A draft without any \cite yet is normal: BibTeX just produces an empty bibliography.
        severity: /^I found no \\citation commands/.test(m[1]!) ? 'warning' : 'error',
        source: 'bibtex',
        message: m[1]!.replace(/---while reading file.*$/, '').trim(),
        file: null,
        line: null,
        context: null,
      });
    }
  }
  return dedupe(out);
}

/** Parse a biber `.blg` file. */
export function parseBiberLog(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of blg.split(/\r?\n/)) {
    const m = /\b(WARN|ERROR) - (.*)$/.exec(line);
    if (!m) continue;
    out.push({
      severity: m[1] === 'ERROR' ? 'error' : 'warning',
      source: 'biber',
      message: m[2]!.trim(),
      file: null,
      line: null,
      context: null,
    });
  }
  return dedupe(out);
}

/** Problems that only latexmk itself reports. */
export function parseLatexmkOutput(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^Latexmk: Maximum runs of .* reached without getting stable files/.test(line)) {
      out.push({
        severity: 'warning',
        source: 'latexmk',
        message: line.replace(/^Latexmk: /, ''),
        file: null,
        line: null,
        context: null,
      });
    }
    if (/^Latexmk: .*(?:not found|does not exist|Cannot find)/i.test(line)) {
      out.push({
        severity: 'error',
        source: 'latexmk',
        message: line.replace(/^Latexmk: /, ''),
        file: null,
        line: null,
        context: null,
      });
    }
  }
  return dedupe(out);
}
