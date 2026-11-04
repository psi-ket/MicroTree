import { PROVIDER_KINDS, ProviderError, validateRequestContent, type ModelProvider, type ModelRequest, type StructuredOutputSpec } from '@research-studio/ai-core';
import type { PassageCandidate } from '@research-studio/evidence-engine';

/** A provider that answers structured calls from a queue and records what it was sent. */
export class ScriptedProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  readonly capabilities = PROVIDER_KINDS.ollama.capabilities;
  requests: { request: ModelRequest; spec: string; text: string }[] = [];
  answers: (unknown | Error)[] = [];
  async listModels() {
    return [];
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('not used');
  }
  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>) {
    validateRequestContent(request, this.capabilities);
    if (request.signal?.aborted) throw new ProviderError('cancelled', 'cancelled');
    const text = request.messages.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((c) => (c.type === 'text' ? c.text : '')))).join('\n');
    this.requests.push({ request, spec: spec.name, text });
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    return { value: spec.parse(next), usage: { inputTokens: 500, outputTokens: 80, cachedInputTokens: null, costUsd: null } };
  }
}

export function passage(id: string, text: string, paper: Partial<PassageCandidate['paper']> & { work?: string } = {}, extra: Partial<PassageCandidate> = {}): PassageCandidate {
  return {
    level: 'full_text',
    passageId: id,
    extractionId: 'dex_1',
    attachmentId: 'att_1',
    libraryItemId: `item:${paper.work ?? 'w1'}`,
    scholarlyWorkId: paper.work ?? 'w1',
    externalId: null,
    text,
    textHash: `h:${id}`,
    stableKey: `k:${id}`,
    sectionPath: 'Results',
    sectionType: 'results',
    pageStart: 3,
    pageEnd: 3,
    coordinates: [],
    sourceSha256: 'sha',
    extractorVersion: '0.8',
    paper: { title: 'A synthetic paper', authors: ['A. Author'], year: 2020, venue: null, doi: null, arxivId: null, publicationType: 'journal-article', url: null, ...paper },
    method: 'hybrid',
    keywordRank: 1,
    semanticRank: null,
    score: 0.03,
    ...extra,
  };
}
