/**
 * A LanguageModel that answers nothing.
 *
 * During ingestion the agent exists only to carry the Observational Memory
 * processors — its own replies are never read. Giving it a real model would
 * multiply the cost of the most expensive phase for output nobody uses, so the
 * main model is stubbed and only Observer and Reflector make real calls.
 */
import type { LanguageModelV2 } from '@ai-sdk/provider';

export function createMockModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-ingest-model',
    supportedUrls: {},
    async doGenerate() {
      return {
        // Empty, so the stub's own replies never enter the observation stream.
        content: [],
        finishReason: 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('The ingestion mock model does not implement streaming.');
    },
  };
}
