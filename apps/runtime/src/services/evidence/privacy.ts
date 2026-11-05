import { PROVIDER_KINDS, privacyModeOf, type ModelProvider } from '@research-studio/ai-core';
import type { EvidenceSettings } from '@research-studio/api-contracts';
import type { Repositories } from '@research-studio/database';
import { EVIDENCE_MODEL_TASKS, StudioError, type EvidenceModelTask } from '@research-studio/shared-types';
import type { AiProviderService } from '../ai/provider-service';
import type { AuditService } from '../audit-service';
import type { Actor } from '../project-service';

const KEY = 'evidence';
const scope = (projectId: string) => `project:${projectId}`;

/** Local-first default: nothing leaves the computer until the project allows it. */
export const DEFAULT_SETTINGS: EvidenceSettings = {
  privacyMode: 'local-only',
  allowedProviders: [],
  models: Object.fromEntries(EVIDENCE_MODEL_TASKS.map((t) => [t, null])) as EvidenceSettings['models'],
};

export interface Outgoing {
  /** What would leave the computer, as counts and short previews (shown in the consent dialog). */
  manuscriptChars: number;
  sourceChars: number;
  passages: number;
  requests: number;
  preview: { claims: string[]; passages: { title: string; excerpt: string }[] };
}

export interface ResolvedModel {
  provider: ModelProvider;
  providerId: string;
  providerKind: string;
  model: string;
  privacyMode: 'local' | 'cloud';
  consentAt: string | null;
}

/**
 * Project privacy for M5 model calls. `local-only` (the default) refuses any
 * provider that is not Ollama on this computer; `cloud-allowed` permits
 * cloud providers (all, or the listed ones) with consent for each operation;
 * `confidential` refuses cloud processing whatever the request says.
 */
export class EvidencePrivacy {
  constructor(
    private readonly repos: Repositories,
    private readonly providers: AiProviderService,
    private readonly audit: AuditService,
  ) {}

  settings(projectId: string): EvidenceSettings {
    const stored = this.repos.settings.get(scope(projectId), KEY) as Partial<EvidenceSettings> | undefined;
    return { ...DEFAULT_SETTINGS, ...stored, models: { ...DEFAULT_SETTINGS.models, ...(stored?.models ?? {}) } };
  }

  update(projectId: string, patch: Partial<EvidenceSettings>, actor: Actor): EvidenceSettings {
    const next = { ...this.settings(projectId), ...patch, models: { ...this.settings(projectId).models, ...(patch.models ?? {}) } };
    this.repos.settings.setMany(scope(projectId), { [KEY]: next });
    this.audit.record({ action: 'evidence.settings', outcome: 'success', actor: actor.sessionId, projectId, details: { privacyMode: next.privacyMode, allowedProviders: next.allowedProviders } });
    return next;
  }

  /** Instantiate the chosen model and enforce the project's privacy settings and the per-operation consent. */
  async resolve(projectId: string, choice: { providerId: string; model: string; consent: boolean }, task: EvidenceModelTask, outgoing: Outgoing, actor: Actor): Promise<ResolvedModel> {
    const { record, provider } = await this.providers.instantiate(choice.providerId);
    if (!provider.capabilities.structuredOutput) throw new StudioError('BAD_REQUEST', `${record.displayName} cannot return structured answers; choose OpenAI, Anthropic, Gemini, Ollama, Claude Code or Codex`, { reason: 'NO_STRUCTURED_OUTPUT' });
    const mode = privacyModeOf(record.kind, record.baseUrl ?? PROVIDER_KINDS[record.kind].defaultBaseUrl ?? null);
    const settings = this.settings(projectId);
    let consentAt: string | null = null;
    if (mode === 'cloud') {
      const deny = (code: 'FORBIDDEN' | 'CONFLICT', reason: string, message: string) => {
        this.audit.record({ action: 'evidence.cloud', outcome: 'denied', actor: actor.sessionId, projectId, details: { reason, provider: choice.providerId, model: choice.model, task } });
        return new StudioError(code, message, { reason, provider: record.displayName, model: choice.model, privacyMode: settings.privacyMode });
      };
      if (settings.privacyMode === 'confidential') throw deny('FORBIDDEN', 'CONFIDENTIAL_PROJECT', 'This project is marked confidential: its text is never sent to cloud models. Use a local model.');
      if (settings.privacyMode === 'local-only') throw deny('CONFLICT', 'LOCAL_ONLY', 'This project allows local models only. Allow cloud providers in the project’s evidence settings, or use a local model.');
      if (settings.allowedProviders.length && !settings.allowedProviders.includes(choice.providerId)) throw deny('FORBIDDEN', 'PROVIDER_NOT_ALLOWED', `${record.displayName} is not among this project's allowed providers.`);
      if (!choice.consent) {
        throw new StudioError('CONFLICT', `This sends manuscript text${outgoing.passages ? ' and source passages' : ''} to ${record.displayName} (${choice.model}), which runs outside this computer. Confirm to continue.`, {
          reason: 'CONSENT_REQUIRED',
          provider: record.displayName,
          providerKind: record.kind,
          model: choice.model,
          task,
          outgoing,
        });
      }
      consentAt = new Date().toISOString();
      this.audit.record({ action: 'evidence.cloud', outcome: 'success', actor: actor.sessionId, projectId, details: { provider: choice.providerId, model: choice.model, task, manuscriptChars: outgoing.manuscriptChars, sourceChars: outgoing.sourceChars, passages: outgoing.passages } });
    }
    return { provider, providerId: choice.providerId, providerKind: record.kind, model: choice.model, privacyMode: mode, consentAt };
  }
}
