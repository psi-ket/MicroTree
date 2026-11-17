import { tableText } from './graph-data';

export async function readGraphWorkbook(
  bytes: ArrayBuffer,
): Promise<{ name: string; text: string }[]> {
  const { Workbook, ValueType } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const sheets = workbook.worksheets.map((ws) => {
    if (ws.rowCount > 10001 || ws.columnCount > 100)
      throw new Error('Use at most 10,000 data rows and 100 columns per sheet.');
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) =>
      rows.push(
        Array.from({ length: ws.columnCount }, (_, i) => {
          const cell = row.getCell(i + 1);
          return cell.type === ValueType.Formula ? String(cell.result ?? '') : cell.text;
        }),
      ),
    );
    return { name: ws.name, text: tableText(rows) };
  });
  if (!sheets.length) throw new Error('This workbook has no worksheets.');
  return sheets;
}
