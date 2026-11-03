import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where API keys are kept. Secrets are only ever read by the runtime; no API
 * returns them. Keys are addressed by an opaque reference such as `provider:<id>`.
 */
export interface SecretStore {
  readonly kind: 'keyring' | 'file' | 'memory';
  /** Shown in the UI when the store has a limitation worth knowing about. */
  readonly notice: string | null;
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  private readonly values = new Map<string, string>();
  constructor(readonly notice: string | null = null) {}
  async get(ref: string) {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string) {
    this.values.set(ref, value);
  }
  async delete(ref: string) {
    this.values.delete(ref);
  }
}

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null>;
  deletePassword(): Promise<boolean>;
}
type EntryFactory = (service: string, account: string) => KeyringEntry;

/** The OS credential store: Windows Credential Manager, macOS Keychain, or the Secret Service on Linux. */
export class KeyringSecretStore implements SecretStore {
  readonly kind = 'keyring' as const;
  readonly notice = null;
  constructor(
    private readonly service: string,
    private readonly entry: EntryFactory,
  ) {}

  async get(ref: string) {
    return this.entry(this.service, ref).getPassword();
  }
  async set(ref: string, value: string) {
    await this.entry(this.service, ref).setPassword(value);
  }
  async delete(ref: string) {
    await this.entry(this.service, ref).deletePassword();
  }
}

/**
 * Fallback for machines without a usable credential store, used only when
 * explicitly chosen (`RS_SECRET_STORE=file`). Plain JSON readable only by the
 * current user (on Windows, the profile directory's ACL applies).
 */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly notice = 'API keys are stored in a file in the runtime data directory, readable by your user account.';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async save(values: Record<string, string>) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(values), { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get(ref: string) {
    return this.serial(async () => (await this.load())[ref] ?? null);
  }
  set(ref: string, value: string) {
    return this.serial(async () => this.save({ ...(await this.load()), [ref]: value }));
  }
  delete(ref: string) {
    return this.serial(async () => {
      const values = Object.entries(await this.load()).filter(([key]) => key !== ref);
      await this.save(Object.fromEntries(values));
    });
  }
}

export const SECRET_STORE_MODES = ['auto', 'keyring', 'file', 'memory'] as const;
export type SecretStoreMode = (typeof SECRET_STORE_MODES)[number];

/** Distinct keyring service per data directory, so test and dev runtimes never share keys. */
export function keyringService(dataDir: string): string {
  const digest = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 10);
  return `research-studio/${digest}`;
}

async function loadKeyring(): Promise<EntryFactory | null> {
  try {
    const mod = (await import('@napi-rs/keyring')) as { AsyncEntry: new (service: string, account: string) => KeyringEntry };
    return (service, account) => new mod.AsyncEntry(service, account);
  } catch {
    return null;
  }
}

/** Write, read back and remove a probe entry: proves the store is unlocked and usable. */
async function probe(store: KeyringSecretStore): Promise<boolean> {
  const ref = `probe:${process.pid}`;
  try {
    await store.set(ref, 'ok');
    const ok = (await store.get(ref)) === 'ok';
    await store.delete(ref);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Pick the secret store. `auto` uses the OS credential store when it works and
 * otherwise keeps keys in memory only (never silently on disk).
 */
export async function createSecretStore(mode: SecretStoreMode, dataDir: string): Promise<SecretStore> {
  if (mode === 'memory') return new MemorySecretStore('API keys are kept in memory and are forgotten when the runtime stops.');
  if (mode === 'file') return new FileSecretStore(path.join(dataDir, 'secrets.json'));
  const factory = await loadKeyring();
  const store = factory ? new KeyringSecretStore(keyringService(dataDir), factory) : null;
  if (store && (await probe(store))) return store;
  if (mode === 'keyring') throw new Error('RS_SECRET_STORE=keyring, but the OS credential store is not available.');
  return new MemorySecretStore(
    'No OS credential store is available, so API keys are kept in memory until the runtime stops. Set RS_SECRET_STORE=file to keep them in a protected file instead.',
  );
}
