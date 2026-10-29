/**
 * Answers a conversation's questions with stock Mastra and Observational Memory.
 *
 * The agent is exactly what `new Agent({ model, memory })` gives any application:
 * OM's own defaults (thread scope, 30k/40k thresholds), no instructions, no extra
 * tools, no recall guidance, no question framing, no model settings. Models go
 * through Mastra's model router as plain `provider/model` strings. The only
 * addition is OM's documented `retrieval: { vector: true }`: observation groups
 * are embedded as written and the agent gets OM's recall tool, with its native
 * instructions and nothing appended.
 *
 * One departure from core defaults: answers are generated with `maxSteps: 100`.
 * Core otherwise stops at five steps, which caps the recall tool at about four
 * calls and returns an empty answer if the fifth step is a call too. 100 is a
 * ceiling, not a budget.
 *
 * Two things are harness, and neither reaches a prompt:
 *  - Isolation. Each question is asked against a fresh copy of the finished
 *    memory, one minute after the conversation's last message, and the copy is
 *    discarded, so questions cannot affect each other.
 *  - Time. The question is asked at that simulated moment, so OM's relative dates
 *    ("3 weeks ago") are computed from the conversation's own clock.
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { join } from 'node:path';

import { conversationThreadId } from '../data/loader';
import type { BeamConversation, BeamQuestion } from '../data/types';
import { EMBEDDER } from '../config';
import { realNow, withSimulatedNow } from '../ingest/clock';
import { createOpenRouterEmbedder } from '../models/embedding';
import { BenchmarkVectorStore, createBenchmarkStorage } from '../storage';

export const PROMPT_VERSION = 'stock@1';
const MAX_STEPS = 100;
const MAX_ATTEMPTS = 3;

/**
 * `new Agent` without `instructions`. The runtime accepts it and sends no system
 * message (identical to passing ''); only the constructor's type still marks the
 * field required, hence the cast.
 */
const agentWithoutInstructions = (config: { id: string; name: string; model: unknown; memory: Memory }) =>
  new Agent(config as unknown as ConstructorParameters<typeof Agent>[0]);

export interface Answer {
  questionId: string;
  ability: string;
  question: string;
  hypothesis: string;
  promptVersion: string;
  answerContextTokens: number;
  observationTokens: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** The literal request the answering model received on its last step. */
  request?: unknown;
  toolCalls?: number;
  toolTrace?: string[];
  finishReason?: string;
  usage?: unknown;
  attempts: number;
}

export async function answerConversation(options: {
  conversation: BeamConversation;
  questions: BeamQuestion[];
  /** Model-router id OM observes with while answering. Use the one that built the memory. */
  observerModel: string;
  /** Model-router id that answers, e.g. `anthropic/claude-opus-5-5`. */
  actorModel: string;
  /** Directory holding the finished memory: `om.json` and `vectors.json`. */
  snapshotDir: string;
  onProgress?: (line: string) => void;
  onAnswer?: (answer: Answer) => Promise<void> | void;
}): Promise<void> {
  const { conversation, questions } = options;
  const embedder = createOpenRouterEmbedder(EMBEDDER);
  const memoryFor = (storage: ReturnType<typeof createBenchmarkStorage>['storage'], vector: BenchmarkVectorStore) =>
    new Memory({
      storage,
      vector,
      embedder: embedder as never,
      options: { observationalMemory: { model: options.observerModel, retrieval: { vector: true } } },
    });

  const endState = join(options.snapshotDir, 'om.json');
  const endVectors = join(options.snapshotDir, 'vectors.json');
  const threadId = conversationThreadId(conversation.conversationId);
  const resourceId = `beam_${conversation.tier}_${conversation.chatId}`;

  const lastAt = Math.max(...conversation.threads.flatMap(t => t.messages.map(m => m.createdAt.getTime())));
  const askAt = new Date(lastAt + 60_000);
  for (const question of questions) {
    const copy = createBenchmarkStorage();
    await copy.memoryStore.hydrate(endState);
    const copyVector = new BenchmarkVectorStore();
    await copyVector.hydrate(endVectors);
    const agent = agentWithoutInstructions({ id: 'beam-answer', name: 'BEAM answer', model: options.actorModel, memory: memoryFor(copy.storage, copyVector) });
    const started = realNow();
    let response: Awaited<ReturnType<typeof agent.generate>> | undefined;
    let attempts = 0;
    // Transient provider failures are retried; the request is identical each time.
    while (!response && attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        response = await withSimulatedNow(askAt, () => agent.generate(question.question, { memory: { thread: threadId, resource: resourceId }, maxSteps: MAX_STEPS }));
      } catch (error) {
        options.onProgress?.(`${question.questionId} attempt ${attempts} failed: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    await copyVector.close();
    if (!response) continue;
    const steps = ((response as { steps?: Array<{ toolCalls?: Array<{ payload?: { args?: unknown } }> }> }).steps ?? []);
    const calls = steps.flatMap(s => s.toolCalls ?? []);
    const usage = (response.totalUsage ?? response.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
    await options.onAnswer?.({
      questionId: question.questionId, ability: question.ability, question: question.question,
      hypothesis: response.text ?? '', promptVersion: PROMPT_VERSION,
      answerContextTokens: usage.inputTokens ?? 0, observationTokens: 0,
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
      latencyMs: realNow() - started,
      request: (response as { request?: { body?: unknown } }).request?.body,
      usage: response.totalUsage ?? response.usage, attempts,
      toolCalls: calls.length, toolTrace: calls.map(c => JSON.stringify(c.payload?.args ?? '').slice(0, 300)),
      finishReason: String(response.finishReason ?? ''),
    });
  }
}
