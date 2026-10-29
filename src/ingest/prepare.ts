/**
 * Ingests one BEAM conversation into Observational Memory and snapshots it.
 *
 * BEAM's 20 questions share one conversation, so this prepares per conversation
 * and lets all 20 questions fan out against a read-only copy of the same snapshot.
 *
 * A snapshot can also be written during the run (BEAM_SNAPSHOT_EVERY=n batches),
 * so a long 10M ingest that stops can continue from the last one (BEAM_RESUME=1).
 */
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import type { LanguageModelV2, LanguageModelV2CallOptions } from '@ai-sdk/provider';

import { writeJsonAtomic } from '../atomic-write';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';

import { conversationThreadId } from '../data/loader';
import type { BeamConversation } from '../data/types';
import { EMBEDDER } from '../config';
import { createMockModel } from '../models/mock';
import { realNow, withSimulatedNow } from './clock';
import { createOpenRouterEmbedder } from '../models/embedding';
import { BenchmarkVectorStore, createBenchmarkStorage } from '../storage';

/** OM's own default (30k message tokens). Reflection is left at its default too (40k observation tokens). */
const OBSERVATION_MESSAGE_TOKENS = 30_000;
/**
 * How long to wait for a background observation before moving on. OM's own
 * default is 30 s and it returns silently on timeout, which would let ingest
 * run ahead of a slow observer call and snapshot with it still in flight.
 */
const BUFFER_WAIT_MS = 30 * 60 * 1000;

export interface PrepareOptions {
  conversation: BeamConversation;
  /** Model driving Observer and Reflector — the only real calls ingestion makes. */
  observerModel: unknown;
  /** Root for snapshots; the conversation gets `<root>/<tier>/<chatId>/<config>/`. */
  snapshotDir: string;
  /** Names the snapshot directory, e.g. `om-haiku`. */
  config: string;
  /** Write a snapshot after every batch. On by default; that curve is the headline result. */
  snapshotEveryBatch?: boolean;
  onProgress?: (event: PrepareProgress) => void;
}

export interface PrepareProgress {
  batchNumber: number;
  threadsDone: number;
  threadsTotal: number;
  observation: ObservationSize;
}

export interface PrepareResult {
  conversationId: string;
  config: string;
  datePolicy: string;
  /** Snapshot path per batch number, plus the final `om.json`. */
  snapshots: Record<string, string>;
  finalSnapshot: string;
  /** Observation-log size after each batch — the input to the observer multiplier. */
  observationByBatch: Record<string, ObservationSize>;
  threadCount: number;
  messageCount: number;
  elapsedMs: number;
  /** Set when the run continued from a kept batch snapshot (BEAM_RESUME=1). */
  resumedFrom?: number;
}

/**
 * Size of the observation log held in a snapshot.
 *
 * This is the number the whole ingestion budget rests on: the Observer's input
 * per batch is its system prompt plus the batch plus the observation log so far,
 * and only the last term has to be measured. Read from OM's own accounting
 * rather than estimated.
 */
export interface ObservationSize {
  chars: number;
  tokens: number;
  totalTokensObserved: number;
}

function observationSize(snapshot: string): ObservationSize {
  const parsed = JSON.parse(snapshot) as {
    observationalMemory?: Array<[string, Array<Record<string, unknown>>]>;
  };
  // The LATEST record is authoritative — OM keeps running totals on the record
  // itself, and summing across records double-counts once more than one exists.
  const records = (parsed.observationalMemory ?? []).flatMap(([, value]) => value);
  const latest = records.sort(
    (a, b) => new Date(String(b.updatedAt ?? 0)).getTime() - new Date(String(a.updatedAt ?? 0)).getTime(),
  )[0];
  return {
    chars: String(latest?.activeObservations ?? '').length,
    tokens: Number(latest?.observationTokenCount ?? 0),
    totalTokensObserved: Number(latest?.totalTokensObserved ?? 0),
  };
}

export async function prepareConversation(options: PrepareOptions): Promise<PrepareResult> {
  const { conversation, snapshotDir, config } = options;
  const snapshotEveryBatch = options.snapshotEveryBatch ?? true;
  const started = realNow();

  const outputDir = join(snapshotDir, conversation.tier, conversation.chatId, config);
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  const { memoryStore, storage } = createBenchmarkStorage();

  // OM configured through Memory, and the Memory given to the Agent, as an
  // application would. Consequences, all deliberate:
  //   - the Agent wires the OM processor itself; OM manages both loading
  //     context and saving messages, so there is no manual MessageHistory and
  //     no `lastMessages` setting (OM disables history loading internally, and
  //     setting it externally risks the same messages entering the context
  //     twice — once from history, once from OM);
  //   - scope is 'thread', OM's default: the whole conversation runs through
  //     one thread id and observations are keyed to it.
  // OM catches a failed background observer call, logs it to its own debug
  // file and carries on; nothing in the snapshot would show the gap. Count
  // failures here so ingest can stop instead.
  let observerFailures = 0;
  const base = options.observerModel as LanguageModelV2;
  const observerModel: LanguageModelV2 = {
    ...base,
    async doGenerate(call: LanguageModelV2CallOptions) {
      try {
        return await base.doGenerate(call);
      } catch (error) {
        observerFailures++;
        throw error;
      }
    },
    async doStream(call: LanguageModelV2CallOptions) {
      try {
        return await base.doStream(call);
      } catch (error) {
        observerFailures++;
        throw error;
      }
    },
  };

  // OM at its defaults, with search over the archive turned on: each observation group is
  // embedded and the answering agent gets OM's `recall` tool.
  const vector = new BenchmarkVectorStore();
  const memory = new Memory({
    storage,
    vector,
    embedder: createOpenRouterEmbedder(EMBEDDER) as never,
    options: {
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        scope: 'thread',
        retrieval: { vector: true, scope: 'thread' as const },
        observation: {
          model: observerModel as never,
          messageTokens: OBSERVATION_MESSAGE_TOKENS,
        },
        reflection: {
          model: observerModel as never,
        },
      },
    },
  });

  const agent = new Agent({
    id: 'beam-ingest',
    name: 'BEAM Ingest Agent',
    instructions: 'You are a helpful assistant. Process and store conversation history.',
    model: createMockModel() as never,
    memory,
  });

  const threadId = conversationThreadId(conversation.conversationId);
  const engine = await memory.omEngine;
  if (!engine) throw new Error('Observational Memory did not initialise on the Memory instance');

  // Buffered observations only become visible to a read-only reader once
  // activated, which OM does on its own at the threshold. Anything still
  // buffered when a batch ends is activated here so no snapshot hides it.
  // OM's wait returns silently on timeout. Treat both a timeout and a failed
  // observer call as fatal for the conversation: better no snapshot than one
  // with a hole in it.
  const awaitObserver = async () => {
    const started = realNow();
    await engine.waitForBuffering(threadId, resourceId, BUFFER_WAIT_MS);
    if (realNow() - started >= BUFFER_WAIT_MS) {
      throw new Error(`${conversation.conversationId}: observer still running after ${BUFFER_WAIT_MS / 60_000} min`);
    }
    if (observerFailures > 0) {
      throw new Error(`${conversation.conversationId}: ${observerFailures} observer call(s) failed after retries`);
    }
  };

  const settle = async () => {
    await awaitObserver();
    const status = await engine.getStatus({ threadId, resourceId });
    if (status.canActivate) await engine.activate({ threadId, resourceId });
  };
  const resourceId = `beam_${conversation.tier}_${conversation.chatId}`;
  const snapshots: Record<string, string> = {};
  const observationByBatch: Record<string, ObservationSize> = {};

  const batchNumbers = [...new Set(conversation.threads.map(thread => thread.batchNumber))];
  let threadsDone = 0;
  let messageCount = 0;

  // BEAM_RESUME=1: continue from the last kept batch snapshot in the output
  // directory. A 10M ingest runs for hours; with BEAM_SNAPSHOT_EVERY=n at most
  // n batches are lost if it stops.
  let resumedFrom = 0;
  if (process.env.BEAM_RESUME === '1') {
    // A keeper counts only when both halves are on disk: a stop between the two writes leaves an unpaired store file.
    const names = await readdir(outputDir);
    const kept = names
      .map(f => Number(/^batch-(\d+)\.json$/.exec(f)?.[1] ?? 0))
      .filter(n => n && (!vector || names.includes(`batch-${n}.vectors.json`)));
    if (kept.length) {
      resumedFrom = Math.max(...kept);
      await memoryStore.hydrate(join(outputDir, `batch-${resumedFrom}.json`));
      if (vector) await vector.hydrate(join(outputDir, `batch-${resumedFrom}.vectors.json`));
      console.log(`  resuming ${conversation.conversationId} after batch ${resumedFrom}`);
    }
  }

  for (const batchNumber of batchNumbers) {
    const threads = conversation.threads.filter(thread => thread.batchNumber === batchNumber);
    if (batchNumber <= resumedFrom) {
      threadsDone += threads.length;
      continue;
    }

    for (const thread of threads) {
      // One user/assistant pair at a time, so the Observer gets many chances to
      // observe rather than one. Sending a whole turn at once measurably starves it.
      for (let i = 0; i < thread.messages.length; i += 2) {
        // DRIFT: Mastra's exploration sets a top-level `createdAt` on each
        // message. Published @mastra/core reads it from `metadata.createdAt` for
        // model messages and silently stamps wall-clock time otherwise — which
        // dates every observation to the day the benchmark ran and quietly
        // destroys the temporal-reasoning results.
        const pair = thread.messages.slice(i, i + 2).map(message => ({
          role: message.role,
          content: message.content,
          metadata: { createdAt: message.createdAt },
        }));
        const requestContext = new RequestContext([['MastraMemory', { thread: { id: threadId }, resourceId }]]);

        // OM reads "now" from the process clock, so each pair runs at its own time.
        const pairDate = pair[0]?.metadata.createdAt ?? thread.messages[0]!.createdAt;
        await withSimulatedNow(pairDate, async () => {
          await agent.generate(pair as never, {
            memory: { thread: threadId, resource: resourceId },
            requestContext,
            modelSettings: { temperature: 0 },
          });
          // Pause ingest until any background observation this pair kicked off
          // has landed. Ingest is far faster than a real conversation; without
          // this, observer calls overlap.
          await awaitObserver();
        });
        messageCount += pair.length;
      }
      threadsDone++;
    }

    await withSimulatedNow(threads.at(-1)!.messages.at(-1)!.createdAt, settle);

    if (snapshotEveryBatch) {
      // Every batch snapshot repeats the whole store so far. At 100K that is a
      // few MB per conversation; at 1M it is hundreds. BEAM_SNAPSHOT_EVERY=n keeps
      // every nth batch (the final om.json is always written).
      const every = Number(process.env.BEAM_SNAPSHOT_EVERY ?? '10');
      const path = join(outputDir, `batch-${batchNumber}.json`);
      // Always written and read back for the size; only keepers stay on disk.
      await memoryStore.persist(path);
      observationByBatch[String(batchNumber)] = observationSize(await readFile(path, 'utf8'));
      if (batchNumber % every === 0) {
        snapshots[String(batchNumber)] = path;
        if (vector) await vector.persist(join(outputDir, `batch-${batchNumber}.vectors.json`));
      } else await unlink(path);
      options.onProgress?.({
        batchNumber,
        threadsDone,
        threadsTotal: conversation.threads.length,
        observation: observationByBatch[String(batchNumber)]!,
      });
    }
  }

  const finalSnapshot = join(outputDir, 'om.json');
  await memoryStore.persist(finalSnapshot);
  // The embedded observation groups, read back by the answer step; its
  // presence beside om.json is what turns retrieval mode on there.
  if (vector) {
    await vector.persist(join(outputDir, 'vectors.json'));
    await vector.close();
  }

  const result: PrepareResult = {
    conversationId: conversation.conversationId,
    config,
    datePolicy: conversation.datePolicy,
    snapshots,
    finalSnapshot,
    observationByBatch,
    threadCount: conversation.threads.length,
    messageCount,
    elapsedMs: realNow() - started,
    ...(resumedFrom ? { resumedFrom } : {}),
  };

  writeJsonAtomic(join(outputDir, 'meta.json'), result);
  return result;
}
