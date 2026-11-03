import type { ModelProvider } from '@research-studio/ai-core';
import type { ModelProviderKind } from '@research-studio/shared-types';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenAiProvider } from './openai';
import type { ProviderConnection } from './util';

export { AnthropicProvider } from './anthropic';
export { OpenAiProvider } from './openai';
export { GeminiProvider } from './gemini';
export { OllamaProvider } from './ollama';
export { DEFAULT_CONNECTION, toProviderError, type ProviderConnection } from './util';

/** Build the adapter for a provider kind. Throws `ProviderError` when required settings are missing. */
export function createModelProvider(kind: ModelProviderKind, connection: ProviderConnection): ModelProvider {
  switch (kind) {
    case 'anthropic':
      return new AnthropicProvider(connection);
    case 'openai':
      return new OpenAiProvider(connection, 'openai');
    case 'openai-compatible':
      return new OpenAiProvider(connection, 'openai-compatible');
    case 'gemini':
      return new GeminiProvider(connection);
    case 'ollama':
      return new OllamaProvider(connection);
  }
}
