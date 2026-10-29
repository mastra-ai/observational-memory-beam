/**
 * Loads BEAM conversations and probing questions off disk.
 *
 * The one rule this module enforces structurally: a conversation directory holds
 * the generator's scaffolding right next to the data — `plan.txt`, `plan_new.txt`,
 * `labels.txt`, `main_spec.txt`, `relationships.txt` all describe the answers.
 * Reads go through `readConversationFile`, which refuses any path outside a
 * two-entry allowlist, so a leak takes a deliberate edit rather than a slip.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getDatePolicy, parseAnchor, questionDateFor, type AnchoredBatch } from './dates';
import {
  BEAM_ABILITIES,
  type BeamAbility,
  type BeamConversation,
  type BeamMessage,
  type BeamQuestion,
  type BeamRaw10MChat,
  type BeamRawBatch,
  type BeamRawChat,
  type BeamRawProbingQuestions,
  type BeamRawQuestion,
  type BeamThread,
  type BeamTier,
} from './types';

/** The only two files the harness is ever allowed to read from a conversation. */
const ALLOWED_FILES = ['chat.json', 'probing_questions/probing_questions.json'] as const;
type AllowedFile = (typeof ALLOWED_FILES)[number];

/**
 * Generator bookkeeping appended to real user messages, e.g. " ->-> 1,1".
 * Upstream `download_dataset.py` keys on `->->` to detect user messages, so it
 * is load-bearing in the dataset and must be stripped here rather than earlier.
 *
 * The 100K tier carries five variants — `->-> 1,1`, `->-> 1,13)`, `->-> 1,2/A`,
 * `->-> 1,2, 3`, and a double-space form — so matching the payload's charset is
 * guesswork. What every occurrence does share is position: the marker is always
 * terminal, and never leaves more than a dozen characters after it. That is the
 * rule enforced here.
 */
const MARKER = '->->';
const MAX_MARKER_TAIL = 20;

export function readConversationFile(conversationDir: string, file: AllowedFile): string {
  if (!ALLOWED_FILES.includes(file)) {
    throw new Error(`Refusing to read ${JSON.stringify(file)}: BEAM conversation directories contain answer scaffolding.`);
  }
  return readFileSync(join(conversationDir, file), 'utf8');
}

export function conversationDir(dataDir: string, tier: BeamTier, chatId: string): string {
  return join(dataDir, 'chats', tier, chatId);
}

/**
 * Conversation ids for a tier, numerically sorted.
 *
 * Each tier directory also holds a `topics.json`; only subdirectories are
 * conversations. (Counting that file is how the tier sizes came to be
 * overstated by one each.)
 */
export function listConversations(dataDir: string, tier: BeamTier): string[] {
  const tierDir = join(dataDir, 'chats', tier);
  return readdirSync(tierDir)
    .filter(entry => statSync(join(tierDir, entry)).isDirectory())
    .sort((a, b) => Number(a) - Number(b));
}

/** Strips the trailing `->-> n,m` marker and normalizes whitespace. */
export function stripIndexMarker(content: string): string {
  const start = content.lastIndexOf(MARKER);
  if (start < 0 || content.length - start > MAX_MARKER_TAIL) return content.trim();
  return content.slice(0, start).trim();
}

/**
 * Flattens the raw file into batches.
 *
 * The 10M tier carries one extra nesting level — `[{"plan-1": [...batches]}]` —
 * because those conversations are generated from ten chained plans. Plans are
 * sequential, so concatenating them in file order preserves chronology.
 */
function toBatches(raw: BeamRawChat | BeamRaw10MChat): BeamRawBatch[] {
  const first = raw[0];
  if (first && !('turns' in first)) {
    return (raw as BeamRaw10MChat).flatMap(plan => Object.values(plan).flat());
  }
  return raw as BeamRawChat;
}

/**
 * The batch anchor, which BEAM stores on the user message that opens the batch
 * rather than on the batch itself (`batch.time_anchor` is null in every
 * conversation inspected).
 */
function anchorOf(batch: BeamRawBatch): string | undefined {
  const fromMessage = batch.turns.flat().find(message => message.time_anchor)?.time_anchor;
  return fromMessage ?? batch.time_anchor ?? undefined;
}

/**
 * One anchor per batch. A batch with none (10M/7's first batch is the only
 * one seen) takes the next anchored batch's date minus that batch's own gap to
 * its successor, or minus 14 days when there is no successor; a conversation
 * with no anchors at all is an error.
 */
function anchorsOf(batches: BeamRawBatch[], conversationId: string): Date[] {
  const raw = batches.map(batch => { const a = anchorOf(batch); return a ? parseAnchor(a) : undefined; });
  if (!raw.some(Boolean)) throw new Error(`${conversationId} has no time_anchor on any batch`);
  const out: Date[] = new Array(batches.length);
  for (let i = batches.length - 1; i >= 0; i--) {
    if (raw[i]) { out[i] = raw[i]!; continue; }
    const next = out[i + 1];
    if (!next) { out[i] = new Date(raw[i - 1]!.getTime() + 14 * 86_400_000); continue; }
    const gap = out[i + 2] ? Math.max(86_400_000, out[i + 2]!.getTime() - next.getTime()) : 14 * 86_400_000;
    out[i] = new Date(next.getTime() - gap);
  }
  return out;
}

/**
 * Opaque, content-independent thread id.
 *
 * OM writes thread ids into the XML tags it shows the actor, so an id derived
 * from anything meaningful would leak. Derived from position only, and hashed so
 * position leaks nothing either.
 */
function threadIdFor(conversationId: string, batchNumber: number, turnIndex?: number): string {
  const key = turnIndex === undefined ? `${conversationId}:${batchNumber}` : `${conversationId}:${batchNumber}:${turnIndex}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * How BEAM's structure maps onto OM threads.
 *
 * `batch` (the default) makes one thread per batch: ~26 turns sharing a single
 * date anchor, which is both the right size and the right meaning — it is what
 * corresponds to a "session" in LongMemEval, the shape OM was designed and
 * benchmarked against.
 *
 * `turn` makes one thread per mini-session. Measured on real data, this holds
 * 2-6 messages and roughly 620-5,200 tokens per thread, so the Observer's
 * default 30,000-token threshold never trips and no observations are ever
 * written. Kept only so that result can be reproduced.
 */
export type ThreadGranularity = 'batch' | 'turn';

/**
 * The one thread id a conversation's entire history runs through.
 *
 * OM's default scope is per-thread, and Mastra's guidance for this benchmark is
 * to use it: one conversation = one thread, observations keyed to it, questions
 * answered inside it. Batch-level thread ids remain only for loaders that ask
 * for them explicitly.
 */
export function conversationThreadId(conversationId: string): string {
  return createHash('sha256').update(`${conversationId}:conversation`).digest('hex').slice(0, 16);
}

export interface LoadOptions {
  /** Date policy id; defaults to `spread-subday@1`. */
  datePolicy?: string;
  /** Thread mapping; defaults to `batch`. */
  threadGranularity?: ThreadGranularity;
}

export function loadConversation(
  dataDir: string,
  tier: BeamTier,
  chatId: string,
  options: LoadOptions = {},
): BeamConversation {
  const dir = conversationDir(dataDir, tier, chatId);
  const conversationId = `${tier}/${chatId}`;
  const batches = toBatches(JSON.parse(readConversationFile(dir, 'chat.json')));
  if (batches.length === 0) throw new Error(`${conversationId} has no batches`);

  const anchors = anchorsOf(batches, conversationId);
  const anchored: AnchoredBatch[] = batches.map((batch, i) => ({
    anchor: anchors[i]!,
    turnMessageCounts: batch.turns.map(turn => turn.length),
  }));

  const policy = getDatePolicy(options.datePolicy);
  const dates = policy.assign(anchored);
  // Timestamps must never go backwards in ingest order: OM finds the messages
  // it has not yet observed by date, so a message dated before the last
  // observed one is never observed at all. The 10M files carry one block of
  // batches (70-79 in 10M/1) anchored 13 days before the block preceding it;
  // those are moved to just after the previous message. 100K and 1M are
  // already monotonic, so this changes nothing there.
  let previous = 0;
  for (const batch of dates) {
    for (const turn of batch) {
      for (let i = 0; i < turn.length; i++) {
        let ts = turn[i]!.getTime();
        if (ts <= previous) {
          ts = previous + 60_000;
          turn[i] = new Date(ts);
        }
        previous = ts;
      }
    }
  }

  const granularity: ThreadGranularity = options.threadGranularity ?? 'batch';
  const threads: BeamThread[] = [];

  batches.forEach((batch, batchIndex) => {
    // Batch number = position in file order. The dataset's own `batch_number`
    // cycles 1..10 across the 100 batches of a 10M conversation; ingest walks
    // batches in this order and OM finds unobserved messages by date, so any
    // other order sends it messages dated before ones it has already seen,
    // which it then never observes.
    const batchNumber = batchIndex + 1;
    const turnMessages = batch.turns.map((turn, turnIndex) =>
      turn.map((message, messageIndex) => ({
        role: message.role,
        content: stripIndexMarker(message.content),
        createdAt: dates[batchIndex]![turnIndex]![messageIndex]!,
      })),
    );

    if (granularity === 'batch') {
      threads.push({
        threadId: threadIdFor(conversationId, batchNumber),
        batchNumber: batchNumber,
        messages: turnMessages.flat() as BeamMessage[],
      });
      return;
    }

    turnMessages.forEach((messages, turnIndex) => {
      threads.push({
        threadId: threadIdFor(conversationId, batchNumber, turnIndex),
        batchNumber: batchNumber,
        turnIndex,
        messages: messages as BeamMessage[],
      });
    });
  });

  return {
    tier,
    chatId,
    conversationId,
    threads,
    questionDate: questionDateFor(anchors),
    datePolicy: policy.id,
  };
}

/** Which field holds the reference answer, per ability. BEAM names it differently in each schema. */
const REFERENCE_FIELD: Record<BeamAbility, string> = {
  abstention: 'ideal_response',
  contradiction_resolution: 'ideal_answer',
  event_ordering: 'answer',
  information_extraction: 'answer',
  instruction_following: 'expected_compliance',
  knowledge_update: 'answer',
  multi_session_reasoning: 'answer',
  preference_following: 'expected_compliance',
  summarization: 'ideal_summary',
  temporal_reasoning: 'answer',
};

export function loadQuestions(dataDir: string, tier: BeamTier, chatId: string): BeamQuestion[] {
  const dir = conversationDir(dataDir, tier, chatId);
  const raw: BeamRawProbingQuestions = JSON.parse(readConversationFile(dir, 'probing_questions/probing_questions.json'));
  const conversationId = `${tier}/${chatId}`;

  return BEAM_ABILITIES.flatMap(ability =>
    (raw[ability] ?? []).map((item: BeamRawQuestion, index: number) => ({
      questionId: `${conversationId}/${ability}/${index}`,
      conversationId,
      tier,
      ability,
      index,
      question: item.question,
      rubric: item.rubric,
      reference: String((item as unknown as Record<string, unknown>)[REFERENCE_FIELD[ability]] ?? ''),
      raw: item,
    })),
  );
}

/**
 * What the actor is allowed to see about a question.
 *
 * The raw record carries `source_chat_ids`, `conversation_references` and the
 * reference answer itself. Those exist for the judge and the report; narrowing
 * here makes handing them to the actor a type error rather than a review catch.
 */
export interface ActorQuestion {
  questionId: string;
  question: string;
  questionDate: Date;
}

export function toActorQuestion(question: BeamQuestion, conversation: BeamConversation): ActorQuestion {
  return { questionId: question.questionId, question: question.question, questionDate: conversation.questionDate };
}
