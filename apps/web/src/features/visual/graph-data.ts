export interface DataTable {
  headers: string[];
  rows: string[][];
}

export type NumberFormat = 'auto' | 'dot' | 'comma';

/** Auto treats a lone comma as decimal; explicit modes resolve ambiguous grouping. */
function dataNumber(value: string, format: NumberFormat): number {
  const decimal =
    format === 'auto'
      ? value.lastIndexOf(',') > value.lastIndexOf('.')
        ? 'comma'
        : 'dot'
      : format;
  const pattern =
    decimal === 'comma'
      ? /^[+-]?(?:(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d*)?|,\d+)(?:[eE][+-]?\d+)?$/
      : /^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(value)) return NaN;
  return Number(
    decimal === 'comma' ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, ''),
  );
}

/** Delimited text with quoted fields, escaped quotes and embedded newlines. */
export function parseDataTable(text: string, header = true, delimiter = 'auto'): DataTable {
  if (text.length > 5_000_000) throw new Error('Use a data table smaller than 5 MB.');
  const source = text.replace(/^\uFEFF/, '');
  if (!source.trim()) return { headers: [], rows: [] };
  const first = source.split(/\r?\n/)[0]!;
  const sep =
    delimiter === 'auto' ? (['\t', ';', ','].find((s) => first.includes(s)) ?? ' ') : delimiter;
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === sep || (sep === ' ' && c === '\t'))) {
      if (sep !== ' ' || cell) {
        row.push(cell.trim());
        cell = '';
      }
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (quoted) throw new Error('A quoted field is missing its closing quote.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length > 10001 || width > 100)
    throw new Error('Use at most 10,000 data rows and 100 columns.');
  const labels = header ? rows.shift()! : [];
  const headers = Array.from({ length: width }, (_, i) => labels[i] || `Column ${i + 1}`);
  return { headers, rows };
}

export function selectedSeries(
  table: DataTable,
  x: number,
  ys: number[],
  start: number,
  end: number,
  numberFormat: NumberFormat = 'auto',
) {
  if (!ys.length) throw new Error('Choose at least one Y column.');
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > table.rows.length
  )
    throw new Error('Choose a valid data row range.');
  const numeric = (row: string[], column: number, n: number) => {
    const value = row[column]?.trim();
    const parsed = value ? dataNumber(value, numberFormat) : NaN;
    if (!Number.isFinite(parsed))
      throw new Error(
        `Data row ${n}, ${table.headers[column]}: expected a number. Check the number format and separator settings.`,
      );
    return parsed;
  };
  return ys.map((y) => ({
    name: table.headers[y]!,
    points: table.rows
      .slice(start - 1, end)
      .map((row, i) => ({ x: numeric(row, x, start + i), y: numeric(row, y, start + i) })),
  }));
}

export function tableText(rows: string[][]): string {
  return rows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join('\t')).join('\n');
}
