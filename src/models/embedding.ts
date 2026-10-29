/**
 * An embedding model over OpenRouter's embeddings endpoint, for retrieval-mode
 * memories. One POST per batch of texts.
 */
import type { EmbeddingModelV2 } from '@ai-sdk/provider';

import { withRetry } from './retry';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: the variable must already be in the environment */
}

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';

interface EmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** `dimensions` asks the model for shorter vectors (text-embedding-3 supports it); the raw-transcript index uses 1024. */
export function createOpenRouterEmbedder(model: string, dimensions?: number): EmbeddingModelV2<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (put it in .env)');

  return {
    specificationVersion: 'v2',
    provider: 'openrouter',
    modelId: model,
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,

    async doEmbed({ values }) {
      const json = await withRetry(`openrouter-embed:${model}`, async () => {
        // A network failure (connect timeout, reset) is an outage to wait out, not a strike.
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: values, ...(dimensions ? { dimensions } : {}) }),
          signal: AbortSignal.timeout(2 * 60_000),
        }).catch(error => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryAfterMs: 30_000 }); });
        const body = (await response.json().catch(error => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryAfterMs: 30_000 }); })) as EmbeddingResponse;
        if (!response.ok || body.error) {
          const error = new Error(`openrouter embeddings ${response.status}: ${body.error?.message ?? ''}`);
          if (response.status < 500 && response.status !== 429) throw Object.assign(error, { noRetry: true });
          if (response.status === 429) throw Object.assign(error, { retryAfterMs: 60_000 });
          throw Object.assign(error, { retryAfterMs: 30_000 });
        }
        if ((body.data?.length ?? 0) !== values.length) throw new Error('openrouter embeddings returned the wrong count');
        return body;
      });
      const tokens = json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0;
      return { embeddings: json.data!.map(d => d.embedding), usage: { tokens } };
    },
  };
}
