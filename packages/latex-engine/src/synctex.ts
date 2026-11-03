import path from 'node:path';
import { PathGuard } from '@research-studio/document-engine/node';
import { StudioError, type PdfRect, type SourceLocation } from '@research-studio/shared-types';
import { buildArtifacts, BUILD_DIR, validateMainFile } from './latexmk';
import { buildSanitizedEnv, runProcess } from './process';

const SYNCTEX_TIMEOUT_MS = 10_000;

/** Split `synctex` CLI output into key/value records (one per `Output:` block). */
export function parseSynctexRecords(output: string): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let inResult = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'SyncTeX result begin') {
      inResult = true;
      continue;
    }
    if (line === 'SyncTeX result end') break;
    if (!inResult) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key === 'Output') {
      current = {};
      records.push(current);
    }
    if (current) current[key] = value;
  }
  return records;
}

/** Convert `synctex view` records to highlight rectangles (top-left origin, big points). */
export function forwardRecordsToRects(records: Record<string, string>[]): PdfRect[] {
  const rects: PdfRect[] = [];
  for (const r of records) {
    const page = Number(r.Page);
    const h = Number(r.h);
    const v = Number(r.v);
    const width = Number(r.W);
    const height = Number(r.H);
    if (![page, h, v, width, height].every(Number.isFinite) || page < 1) continue;
    rects.push({ page, x: h, y: v - height, width, height });
  }
  return rects;
}

interface SynctexContext {
  synctexPath: string;
  projectRoot: string;
  mainFile: string;
}

async function runSynctex(ctx: SynctexContext, args: string[], guard: PathGuard): Promise<string> {
  const result = await runProcess({
    command: ctx.synctexPath,
    args,
    cwd: guard.root,
    env: buildSanitizedEnv(),
    timeoutMs: SYNCTEX_TIMEOUT_MS,
    maxOutputBytes: 256 * 1024,
  });
  if (result.timedOut) throw new StudioError('INTERNAL', 'SyncTeX timed out');
  return result.output;
}

function relativePdf(mainFile: string): string {
  const artifacts = buildArtifacts('', mainFile);
  return `${BUILD_DIR}/${path.basename(artifacts.pdfPath)}`;
}

/** Source position → PDF rectangles. Paths are passed relative to the project root. */
export async function synctexForward(
  ctx: SynctexContext & { file: string; line: number; column: number },
): Promise<PdfRect[]> {
  const guard = await PathGuard.create(ctx.projectRoot);
  const { rel } = await guard.resolve(ctx.file);
  const mainFile = validateMainFile(ctx.mainFile);
  const line = Math.max(1, Math.trunc(ctx.line));
  const column = Math.max(0, Math.trunc(ctx.column));
  const output = await runSynctex(
    ctx,
    ['view', '-i', `${line}:${column}:${rel}`, '-o', relativePdf(mainFile)],
    guard,
  );
  return forwardRecordsToRects(parseSynctexRecords(output));
}

/** PDF position → source location, or null when it maps to no project file. */
export async function synctexInverse(
  ctx: SynctexContext & { page: number; x: number; y: number },
): Promise<SourceLocation | null> {
  const guard = await PathGuard.create(ctx.projectRoot);
  const mainFile = validateMainFile(ctx.mainFile);
  const coords = [Math.max(1, Math.trunc(ctx.page)), ctx.x, ctx.y].map((n) => {
    if (!Number.isFinite(n)) throw new StudioError('VALIDATION_FAILED', 'Invalid coordinates');
    return Number(n.toFixed(3));
  });
  const output = await runSynctex(
    ctx,
    ['edit', '-o', `${coords.join(':')}:${relativePdf(mainFile)}`],
    guard,
  );
  const record = parseSynctexRecords(output)[0];
  if (!record?.Input) return null;
  const file = guard.toProjectPath(path.resolve(guard.root, record.Input));
  if (!file || file.startsWith(`${BUILD_DIR}/`)) return null;
  const line = Number(record.Line);
  const column = Number(record.Column);
  if (!Number.isFinite(line) || line < 1) return null;
  return { file, line, column: Number.isFinite(column) && column > 0 ? column : 1 };
}
