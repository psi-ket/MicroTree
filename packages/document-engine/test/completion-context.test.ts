import { describe, expect, it } from 'vitest';
import { detectCompletionContext, openEnvironments } from '../src';

describe('detectCompletionContext', () => {
  it.each([
    ['See \\sec', { kind: 'command', prefix: 'sec', start: 5 }],
    ['\\', { kind: 'command', prefix: '', start: 1 }],
    ['\\begin{ite', { kind: 'begin', prefix: 'ite', start: 7 }],
    ['\\end{', { kind: 'end', prefix: '', start: 5 }],
    ['as in \\cite{knu', { kind: 'cite', prefix: 'knu', start: 12 }],
    ['\\citep[see][p.~2]{a, b', { kind: 'cite', prefix: 'b', start: 21 }],
    ['\\parencite{', { kind: 'cite', prefix: '', start: 11 }],
    ['Fig.~\\ref{fig:', { kind: 'ref', prefix: 'fig:', start: 10 }],
    ['\\cref{eq:a,', { kind: 'ref', prefix: '', start: 11 }],
    ['\\input{sections/in', { kind: 'input', prefix: 'sections/in', start: 7 }],
    ['\\includegraphics[width=\\linewidth]{fig', { kind: 'graphics', prefix: 'fig', start: 35 }],
    ['\\bibliography{refs,ot', { kind: 'bibliography', prefix: 'ot', start: 19 }],
  ])('%s', (text, expected) => {
    expect(detectCompletionContext(text)).toEqual(expected);
  });

  it.each(['plain text', '% \\sec', 'a \\\\', '\\cite{done} more', '\\ref{x} '])('no completion for %j', (text) => {
    expect(detectCompletionContext(text)).toBeNull();
  });

  it('completes after an escaped percent sign', () => {
    expect(detectCompletionContext('50\\% of \\te')).toEqual({ kind: 'command', prefix: 'te', start: 9 });
  });
});

describe('openEnvironments', () => {
  it('tracks nesting and ignores comments', () => {
    const text = '\\begin{document}\n\\begin{itemize}\n\\item x\n% \\end{itemize}\n\\begin{equation}\\end{equation}\n';
    expect(openEnvironments(text)).toEqual(['document', 'itemize']);
  });
});
