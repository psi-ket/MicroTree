import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import { parseDataTable, selectedSeries } from '../src/features/visual/graph-data';
import { readGraphWorkbook } from '../src/features/visual/graph-workbook';

describe('graph data import', () => {
  it('imports the pasted polarization table with decimal commas', () => {
    const table = parseDataTable(`Pol Angle\t1.7\t1.8\t1.9\t1.10\t1.11
19\t33,574\t28,381\t41,109\t41,634\t44,672
24\t38,198\t33,398\t46,406\t47,610\t53,339
29\t46,704\t38,576\t55,103\t50,587\t55,568
34\t48,104\t41,176\t56,602\t54,078\t60,102
39\t57,821\t46,636\t62,491\t53,980\t65,589`);
    expect(table.headers).toEqual(['Pol Angle', '1.7', '1.8', '1.9', '1.10', '1.11']);
    const series = selectedSeries(table, 0, [1, 2, 3, 4, 5], 1, 5);
    expect(series[1]!.points[1]).toEqual({ x: 24, y: 33.398 });
    expect(series[4]!.points[4]).toEqual({ x: 39, y: 65.589 });
    expect(series.map((s) => s.points.length)).toEqual([5, 5, 5, 5, 5]);
  });

  it('reads quoted CSV, BOM, escaped quotes and embedded newlines', () => {
    const table = parseDataTable('\uFEFFTime,"A, B","A ""quoted""\nname"\r\n0,2,3\r\n1,4,5');
    expect(table.headers).toEqual(['Time', 'A, B', 'A "quoted"\nname']);
    expect(selectedSeries(table, 0, [1, 2], 2, 2)).toEqual([
      { name: 'A, B', points: [{ x: 1, y: 4 }] },
      { name: 'A "quoted"\nname', points: [{ x: 1, y: 5 }] },
    ]);
  });

  it('supports explicit decimal conventions without confusing thousands and decimals', () => {
    const table = parseDataTable('x\ty\n1\t33,574');
    expect(selectedSeries(table, 0, [1], 1, 1, 'comma')[0]!.points[0]!.y).toBe(33.574);
    expect(selectedSeries(table, 0, [1], 1, 1, 'dot')[0]!.points[0]!.y).toBe(33574);
    for (const [value, format] of [
      ['1.234,56', 'comma'],
      ['1,234.56', 'dot'],
      ['1.234,56', 'auto'],
      ['1,234.56', 'auto'],
    ] as const) {
      expect(
        selectedSeries(parseDataTable(`x\ty\n1\t${value}`), 0, [1], 1, 1, format)[0]!.points[0]!.y,
      ).toBe(1234.56);
    }
    expect(
      selectedSeries(parseDataTable('x\ty\n1\t-3,3574e+2'), 0, [1], 1, 1)[0]!.points[0]!.y,
    ).toBe(-335.74);
    expect(() => selectedSeries(parseDataTable('x\ty\n1\t1,2,3'), 0, [1], 1, 1, 'dot')).toThrow(
      'number format',
    );
    expect(() => selectedSeries(parseDataTable('x\ty\n1\t1.2.3'), 0, [1], 1, 1, 'comma')).toThrow(
      'number format',
    );
  });

  it('reads pasted Excel cells, whitespace text and headerless data', () => {
    expect(parseDataTable('Time\tValue\n0\t2').rows).toEqual([['0', '2']]);
    expect(parseDataTable('0  2\n1  3', false)).toEqual({
      headers: ['Column 1', 'Column 2'],
      rows: [
        ['0', '2'],
        ['1', '3'],
      ],
    });
    expect(parseDataTable('x;y\n0;2').rows).toEqual([['0', '2']]);
  });

  it('rejects missing or nonnumeric selected values instead of inventing zeros', () => {
    const table = parseDataTable('x,y\n0,\n1,NA');
    expect(() => selectedSeries(table, 0, [1], 1, 2)).toThrow('Data row 1, y');
    expect(() => selectedSeries(table, 0, [1], 2, 2)).toThrow('Data row 2, y');
    expect(() => selectedSeries(table, 0, [1], 1, 3)).toThrow('row range');
    expect(() => parseDataTable('x,"y')).toThrow('closing quote');
    expect(parseDataTable('\tx\n\t2').headers).toEqual(['Column 1', 'x']);
  });

  it('imports multiple real XLSX worksheets and cached formula results', async () => {
    const workbook = new Workbook();
    const first = workbook.addWorksheet('Measurements');
    first.addRows([
      ['Time', 'Value'],
      [0, 3],
      [1, { formula: '1+4', result: 5 }],
    ]);
    workbook.addWorksheet('Other').addRows([
      ['x', 'y'],
      [2, 9],
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    const sheets = await readGraphWorkbook(new Uint8Array(buffer).buffer);
    expect(sheets.map((s) => s.name)).toEqual(['Measurements', 'Other']);
    expect(selectedSeries(parseDataTable(sheets[0]!.text), 0, [1], 1, 2)[0]!.points).toEqual([
      { x: 0, y: 3 },
      { x: 1, y: 5 },
    ]);
  });
});
