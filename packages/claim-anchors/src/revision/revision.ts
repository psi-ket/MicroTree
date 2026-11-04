import { sha256 } from '../hashing/text-hash';

/** A manuscript revision: the content hashes of its files, in reading order. */
export function manuscriptRevision(files: readonly { path: string; content: string }[]): string {
  return sha256(files.map((f) => `${f.path}\u0000${sha256(f.content)}`).join('\n')).slice(0, 24);
}
