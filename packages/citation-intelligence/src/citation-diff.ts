/** A line diff of a small change, for review (longest common subsequence). */
export function lineDiff(a: string, b: string): { kind: 'same' | 'added' | 'removed'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { kind: 'same' | 'added' | 'removed'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'removed', text: x[i++]! });
    else out.push({ kind: 'added', text: y[j++]! });
  }
  while (i < x.length) out.push({ kind: 'removed', text: x[i++]! });
  while (j < y.length) out.push({ kind: 'added', text: y[j++]! });
  return out;
}

/** Keys cited anywhere in a text (for checking that a rewrite keeps them). */
export function citedKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g)) for (const k of m[1]!.split(',')) if (k.trim()) out.push(k.trim());
  return out;
}
