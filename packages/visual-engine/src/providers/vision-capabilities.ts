import type { ModelProvider } from '@research-studio/ai-core';
import { privacyModeOf } from '@research-studio/ai-core';
import type { ModelProviderKind, PrivacyMode, VisualTaskType } from '@research-studio/shared-types';
import { VisualError } from '../errors/visual-errors';

/** Tasks that read an image. Text-to-diagram is the only one that does not. */
export const IMAGE_TASKS: readonly VisualTaskType[] = ['auto', 'equation', 'handwritten-equation', 'derivation', 'diagram', 'quantum-circuit', 'electrical-circuit', 'plot', 'explanation', 'caption'];

export interface ProviderTarget {
  kind: ModelProviderKind;
  /** Base URL as configured (null: the provider's official endpoint). */
  baseUrl: string | null;
  provider: ModelProvider;
  model: string;
}

export interface Route {
  privacyMode: PrivacyMode;
  /** Images (or text) go to another computer; the user must agree per task. */
  needsConsent: boolean;
  /** Per-model vision support when the provider reports it (null: unknown). */
  modelVision: boolean | null;
}

/**
 * Decide whether a provider can run a visual task and how private it is.
 * `local` only for Ollama on this computer; everything else is `cloud` and
 * needs the user's consent for that task. Refuses providers whose adapter
 * cannot send images or return structured output, and local models that say
 * they cannot see images.
 */
export async function routeTask(task: VisualTaskType, target: ProviderTarget, signal?: AbortSignal): Promise<Route> {
  const caps = target.provider.capabilities;
  if (!caps.structuredOutput) throw new VisualError('no-structured-output', `${target.kind} cannot return structured answers here; choose OpenAI, Anthropic, Gemini, Ollama, Claude Code or Codex`);
  const needsImage = IMAGE_TASKS.includes(task);
  let modelVision: boolean | null = null;
  if (needsImage) {
    if (!caps.vision) throw new VisualError('no-vision', `The ${target.kind} adapter cannot send images; choose a provider with image input`);
    if (target.provider.describeModel) {
      try {
        modelVision = (await target.provider.describeModel(target.model, signal)).vision;
      } catch {
        modelVision = null;
      }
      if (modelVision === false) throw new VisualError('no-vision', `The model ${target.model} does not accept images (it reports no vision capability). Choose a vision model, for example one with "vision" or "vl" in its name.`);
    }
  }
  const local = privacyModeOf(target.kind, target.baseUrl) === 'local';
  return { privacyMode: local ? 'local' : 'cloud', needsConsent: !local, modelVision };
}

/** Throws unless a cloud task carries the user's consent. */
export function requireConsent(route: Route, consent: boolean): void {
  if (route.needsConsent && !consent) {
    throw new VisualError('consent-required', 'This provider runs on another computer: confirm that the image may be sent to it', { privacyMode: route.privacyMode });
  }
}
