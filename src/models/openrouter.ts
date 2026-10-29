/**
 * A LanguageModel over OpenRouter's chat-completions endpoint. A plain API call
 * with temperature 0 and reasoning at its lowest setting. This is what grades
 * the answers, so the grader's reasoning setting is part of the method. The key
 * comes from OPENROUTER_API_KEY.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';

import { withRetry } from './retry';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: the variable must already be in the environment */
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface Completion {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; metadata?: { raw?: unknown; provider_name?: string } };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown }
  | { role: 'tool'; tool_call_id: string; content: string };

/** The AI SDK prompt as chat-completions messages; tool calls and results included. */
export function toChatMessages(prompt: LanguageModelV2CallOptions['prompt']): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'system') out.push({ role: 'system', content: message.content });
    else if (message.role === 'user') {
      out.push({ role: 'user', content: message.content.map(p => (p.type === 'text' ? p.text : '')).join('') });
    } else if (message.role === 'assistant') {
      const text = message.content.map(p => (p.type === 'text' ? p.text : '')).join('');
      const calls: ToolCall[] = message.content.flatMap(p =>
        p.type === 'tool-call'
          ? [{ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}) } }]
          : [],
      );
      // Gemini 3.x needs its thought signatures back on the next turn of a tool loop; OpenRouter carries them here.
      const details = message.content.map(p => (p.providerOptions?.openrouter as { reasoning_details?: unknown } | undefined)?.reasoning_details).find(Boolean);
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(details ? { reasoning_details: details } : {}) });
    } else if (message.role === 'tool') {
      for (const p of message.content) {
        if (p.type !== 'tool-result') continue;
        const o = p.output;
        const content = o.type === 'text' || o.type === 'error-text' ? o.value : JSON.stringify(o.value);
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content });
      }
    }
  }
  return out;
}

export function createOpenRouterModel(modelId: string): LanguageModelV2 {
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (put it in .env)');

  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'openrouter',
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV2CallOptions) {
      const tools = (callOptions.tools ?? []).flatMap(t =>
        t.type === 'function' ? [{ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }] : [],
      );
      const body = {
        model: modelId,
        messages: toChatMessages(callOptions.prompt),
        ...(tools.length ? { tools } : {}),
        temperature: callOptions.temperature ?? 0,
        reasoning: { effort: 'minimal' },
      };

      const completion = await withRetry(`openrouter:${modelId}`, async () => {
        // A network failure (connect timeout, reset) is an outage to wait out, not a strike.
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(error => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryAfterMs: 30_000 }); });
        // A body that fails to read is the same outage as a failed connect.
        const json = (await response.json().catch(error => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryAfterMs: 30_000 }); })) as Completion;
        if (!response.ok || json.error) {
          // The upstream provider's own message sits under metadata.raw; without it a 400 says nothing.
          const detail = json.error?.metadata?.raw ? ` (${json.error.metadata.provider_name ?? 'provider'}: ${JSON.stringify(json.error.metadata.raw).slice(0, 300)})` : '';
          const error = new Error(`openrouter ${response.status}: ${json.error?.message ?? ''}${detail}`);
          // A rejected request will be rejected again; only rate limits and server errors are worth retrying.
          if (response.status < 500 && response.status !== 429) throw Object.assign(error, { noRetry: true });
          // A rate limit is worth waiting out: a new model at OpenRouter can throttle for minutes.
          if (response.status === 429) throw Object.assign(error, { retryAfterMs: 2 * 60_000 });
          // A 5xx (gateway timeout, upstream down) is an outage too: wait, do not strike.
          throw Object.assign(error, { retryAfterMs: 30_000 });
        }
        const message = json.choices?.[0]?.message;
        const content = message?.content ?? '';
        const toolCalls = message?.tool_calls ?? [];
        if (!content.trim() && toolCalls.length === 0) throw new Error('openrouter returned an empty message');
        return { json, content, toolCalls, reasoningDetails: message?.reasoning_details };
      });

      const usage = completion.json.usage ?? {};
      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;

      const providerMetadata = completion.reasoningDetails ? { openrouter: { reasoning_details: completion.reasoningDetails as never } } : undefined;
      const content: LanguageModelV2Content[] = [
        ...(completion.content ? [{ type: 'text' as const, text: completion.content, ...(providerMetadata ? { providerMetadata } : {}) }] : []),
        ...completion.toolCalls.map(call => ({
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.function.name,
          input: call.function.arguments || '{}',
          ...(providerMetadata ? { providerMetadata } : {}),
        })),
      ];
      return {
        content,
        finishReason: completion.toolCalls.length ? ('tool-calls' as const) : ('stop' as const),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        warnings: [],
      };
    },

    async doStream(callOptions: LanguageModelV2CallOptions) {
      const result = await model.doGenerate(callOptions);
      const text = result.content.map(part => (part.type === 'text' ? part.text : '')).join('');
      const id = 'txt-0';
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          if (text) {
            controller.enqueue({ type: 'text-start', id });
            controller.enqueue({ type: 'text-delta', id, delta: text });
            controller.enqueue({ type: 'text-end', id });
          }
          for (const part of result.content) if (part.type === 'tool-call') controller.enqueue(part);
          controller.enqueue({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
          controller.close();
        },
      });
      return { stream };
    },
  };

  return model;
}
