import { checkBaseUrl, PROVIDER_KINDS, ProviderError, type ModelProvider } from '@research-studio/ai-core';
import type { AiRepositories, ProviderRecord, SecretStore } from '@research-studio/ai-storage';
import { createModelProvider, type ProviderConnection } from '@research-studio/model-adapters';
import { StudioError, type ModelInfo, type ModelProviderKind, type ProviderConfigView } from '@research-studio/shared-types';
import type { RuntimeConfig } from '../../config';
import { randomId } from '../../security/tokens';
import type { AuditService } from '../audit-service';
import type { Actor } from '../project-service';

export type ModelProviderFactory = (kind: ModelProviderKind, connection: ProviderConnection) => ModelProvider;

export interface ProviderInput {
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string | null;
  defaultModel: string | null;
  apiKey: string | null;
}

export interface ProviderPatch {
  displayName?: string | undefined;
  baseUrl?: string | null | undefined;
  defaultModel?: string | null | undefined;
  enabled?: boolean | undefined;
  apiKey?: string | null | undefined;
}

const secretRef = (id: string) => `provider:${id}`;

/**
 * Model provider settings. Settings live in SQLite; API keys live only in the
 * secret store (OS credential store when available) or the environment, and
 * are never returned by any method that feeds an HTTP response.
 */
export class AiProviderService {
  constructor(
    private readonly repos: AiRepositories,
    private readonly secrets: SecretStore,
    private readonly config: RuntimeConfig,
    private readonly audit: AuditService,
    private readonly env: Record<string, string | undefined>,
    private readonly factory: ModelProviderFactory = createModelProvider,
  ) {}

  async list(): Promise<ProviderConfigView[]> {
    return Promise.all(this.repos.providers.list().map((r) => this.view(r)));
  }

  async get(id: string): Promise<ProviderConfigView> {
    return this.view(this.record(id));
  }

  record(id: string): ProviderRecord {
    const record = this.repos.providers.get(id);
    if (!record) throw new StudioError('NOT_FOUND', 'Model provider not found', { providerId: id });
    return record;
  }

  async create(input: ProviderInput, actor: Actor): Promise<ProviderConfigView> {
    const baseUrl = this.validBaseUrl(input.kind, input.baseUrl);
    const id = `${input.kind}-${randomId(4)}`;
    let ref: string | null = null;
    if (input.apiKey) {
      ref = secretRef(id);
      await this.secrets.set(ref, input.apiKey);
    }
    const record = this.repos.providers.create({
      id,
      kind: input.kind,
      displayName: input.displayName,
      baseUrl,
      defaultModel: input.defaultModel ?? PROVIDER_KINDS[input.kind].defaultModel,
      enabled: true,
      secretRef: ref,
    });
    this.audit.record({ action: 'ai.provider.create', outcome: 'success', actor: actor.sessionId, target: id, details: { kind: input.kind, credential: !!ref } });
    return this.view(record);
  }

  async update(id: string, patch: ProviderPatch, actor: Actor): Promise<ProviderConfigView> {
    const current = this.record(id);
    const changes: Partial<Omit<ProviderRecord, 'id' | 'kind' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.displayName !== undefined) changes.displayName = patch.displayName;
    if (patch.defaultModel !== undefined) changes.defaultModel = patch.defaultModel;
    if (patch.enabled !== undefined) changes.enabled = patch.enabled;
    let credential: 'kept' | 'replaced' | 'removed' = 'kept';
    if (patch.baseUrl !== undefined) {
      const next = this.validBaseUrl(current.kind, patch.baseUrl);
      if (next !== current.baseUrl) {
        changes.baseUrl = next;
        // A key must not follow the provider to a different endpoint.
        if (current.secretRef && patch.apiKey === undefined) {
          await this.secrets.delete(current.secretRef);
          changes.secretRef = null;
          credential = 'removed';
        }
      }
    }
    if (patch.apiKey !== undefined) {
      const ref = current.secretRef ?? secretRef(id);
      if (patch.apiKey === null) {
        await this.secrets.delete(ref);
        changes.secretRef = null;
        credential = 'removed';
      } else {
        await this.secrets.set(ref, patch.apiKey);
        changes.secretRef = ref;
        credential = 'replaced';
      }
    }
    const record = this.repos.providers.update(id, changes)!;
    this.audit.record({
      action: 'ai.provider.update',
      outcome: 'success',
      actor: actor.sessionId,
      target: id,
      details: { fields: Object.keys(patch).filter((k) => k !== 'apiKey'), credential },
    });
    return this.view(record);
  }

  async delete(id: string, actor: Actor): Promise<void> {
    const record = this.record(id);
    if (record.secretRef) await this.secrets.delete(record.secretRef);
    this.repos.providers.delete(id);
    this.audit.record({ action: 'ai.provider.delete', outcome: 'success', actor: actor.sessionId, target: id });
  }

  /** An SDK-backed provider with its credential resolved. Runtime-internal only. */
  async instantiate(id: string): Promise<{ record: ProviderRecord; provider: ModelProvider }> {
    const record = this.record(id);
    if (!record.enabled) throw new StudioError('FORBIDDEN', `${record.displayName} is disabled`);
    const info = PROVIDER_KINDS[record.kind];
    const apiKey = await this.resolveKey(record);
    if (info.capabilities.requiresApiKey && !apiKey) {
      throw new StudioError('NOT_CONFIGURED', `${record.displayName} has no API key. Add one in the assistant's provider settings.`);
    }
    const baseUrl = record.baseUrl ?? info.defaultBaseUrl;
    const provider = this.factory(record.kind, {
      apiKey,
      baseUrl,
      timeoutMs: this.config.ai.requestTimeoutMs,
      maxRetries: 2,
    });
    return { record, provider };
  }

  async listModels(id: string): Promise<ModelInfo[]> {
    const { provider } = await this.instantiate(id);
    try {
      return await provider.listModels(AbortSignal.timeout(30_000));
    } catch (err) {
      throw toStudioError(err);
    }
  }

  private async resolveKey(record: ProviderRecord): Promise<string | null> {
    if (record.secretRef) {
      const stored = await this.secrets.get(record.secretRef);
      if (stored) return stored;
    }
    const envKey = PROVIDER_KINDS[record.kind].envKey;
    // The environment key belongs to the provider's official endpoint only.
    return envKey && !record.baseUrl ? (this.env[envKey] ?? null) : null;
  }

  private validBaseUrl(kind: ModelProviderKind, value: string | null): string | null {
    const trimmed = value?.trim() || null;
    if (!trimmed) {
      if (kind === 'openai-compatible') throw new StudioError('VALIDATION_FAILED', 'An OpenAI-compatible provider needs a base URL');
      return null;
    }
    const problem = checkBaseUrl(trimmed);
    if (problem) throw new StudioError('VALIDATION_FAILED', problem);
    return trimmed.replace(/\/+$/, '');
  }

  private async view(record: ProviderRecord): Promise<ProviderConfigView> {
    const info = PROVIDER_KINDS[record.kind];
    let source: ProviderConfigView['credential']['source'] = 'none';
    if (record.secretRef && (await this.secrets.get(record.secretRef))) source = this.secrets.kind;
    else if (info.envKey && !record.baseUrl && this.env[info.envKey]) source = 'env';
    return {
      id: record.id,
      kind: record.kind,
      displayName: record.displayName,
      baseUrl: record.baseUrl,
      defaultModel: record.defaultModel,
      enabled: record.enabled,
      credential: { required: info.capabilities.requiresApiKey, configured: source !== 'none', source },
      capabilities: info.capabilities,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

/** Map a provider failure to an API error with a user-facing message. */
export function toStudioError(err: unknown): StudioError {
  if (err instanceof StudioError) return err;
  if (err instanceof ProviderError) {
    if (err.code === 'timeout') return new StudioError('TIMEOUT', err.message);
    return new StudioError('PROVIDER_ERROR', err.message, { reason: err.code, status: err.status });
  }
  return new StudioError('PROVIDER_ERROR', 'The model provider request failed');
}
