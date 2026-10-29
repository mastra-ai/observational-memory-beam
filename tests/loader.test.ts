import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  listConversations,
  loadConversation,
  loadQuestions,
  readConversationFile,
  stripIndexMarker,
  toActorQuestion,
} from '../src/data/loader';
import { BEAM_ABILITIES } from '../src/data/types';

const DATA_DIR = process.env.BEAM_DATA_DIR ?? './data/beam';
const hasData = existsSync(`${DATA_DIR}/chats/100K`);
const withData = hasData ? describe : describe.skip;

describe('stripIndexMarker', () => {
  it.each([
    ['Help me plan my week. ->-> 1,1', 'Help me plan my week.'],
    ['Question? ->->  12,3 ', 'Question?'],
    ['Curious about fiction series ->-> 1,13)', 'Curious about fiction series'],
    ['What about budgets ->-> 1,2/A', 'What about budgets'],
    ['And the timeline ->-> 1,2, 3', 'And the timeline'],
  ])('removes the generator marker from %j', (input, expected) => {
    expect(stripIndexMarker(input)).toBe(expected);
  });

  it('leaves message text that merely contains an arrow alone', () => {
    expect(stripIndexMarker('Use a -> b notation here')).toBe('Use a -> b notation here');
  });

  // The marker is always terminal in the dataset. A long tail after "->->" is
  // therefore prose, not bookkeeping, and must survive.
  it('leaves a long tail after the marker intact', () => {
    const prose = 'The mapping is a ->-> b, which we then apply across the whole pipeline.';
    expect(stripIndexMarker(prose)).toBe(prose);
  });
});

describe('readConversationFile', () => {
  it('refuses the generator scaffolding that leaks answers', () => {
    for (const leaky of ['plan.txt', 'plan_new.txt', 'labels.txt', 'main_spec.txt', 'relationships.txt']) {
      expect(() => readConversationFile('/tmp', leaky as never)).toThrow(/Refusing to read/);
    }
  });
});

withData('loader against the real 100K tier', () => {
  const chatIds = hasData ? listConversations(DATA_DIR, '100K') : [];

  it('finds 20 conversations, excluding topics.json', () => {
    expect(chatIds).toHaveLength(20);
    expect(chatIds).not.toContain('topics.json');
    expect(chatIds[0]).toBe('1');
  });

  it.each(chatIds)('loads conversation %s with ordered, marker-free messages', chatId => {
    const conversation = loadConversation(DATA_DIR, '100K', chatId);

    expect(conversation.conversationId).toBe(`100K/${chatId}`);
    expect(conversation.datePolicy).toBe('spread-subday@1');
    expect(conversation.threads.length).toBeGreaterThan(0);

    const messages = conversation.threads.flatMap(thread => thread.messages);
    const times = messages.map(message => message.createdAt.getTime());
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);

    for (const message of messages) {
      expect(message.content).not.toMatch(/->->/);
      expect(message.content.length).toBeGreaterThan(0);
    }

    expect(conversation.questionDate.getTime()).toBeGreaterThan(times.at(-1)!);
  });

  it.each(['batch', 'turn'] as const)('gives every %s its own opaque thread id', granularity => {
    const conversation = loadConversation(DATA_DIR, '100K', '1', { threadGranularity: granularity });
    const ids = conversation.threads.map(thread => thread.threadId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  // The mapping that decides whether the Observer ever runs. Per-turn threads
  // hold a few thousand tokens each and never reach OM's 30k threshold; per-batch
  // threads are the size OM was designed against.
  it('defaults to one thread per batch, holding every message of that batch', () => {
    const byBatch = loadConversation(DATA_DIR, '100K', '1');
    const byTurn = loadConversation(DATA_DIR, '100K', '1', { threadGranularity: 'turn' });

    expect(byBatch.threads).toHaveLength(3);
    expect(byTurn.threads).toHaveLength(78);
    expect(byBatch.threads.map(t => t.messages.length).reduce((a, b) => a + b)).toBe(
      byTurn.threads.map(t => t.messages.length).reduce((a, b) => a + b),
    );
    expect(byBatch.threads[0]!.turnIndex).toBeUndefined();
    expect(byBatch.threads.every(t => t.messages.length > 50)).toBe(true);
  });

  it('is deterministic across loads', () => {
    const a = loadConversation(DATA_DIR, '100K', '2');
    const b = loadConversation(DATA_DIR, '100K', '2');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('changes timestamps, and only timestamps, when the date policy changes', () => {
    const subday = loadConversation(DATA_DIR, '100K', '3');
    const even = loadConversation(DATA_DIR, '100K', '3', { datePolicy: 'spread-even@1' });
    expect(even.datePolicy).toBe('spread-even@1');
    expect(even.threads.map(t => t.messages.map(m => m.content))).toEqual(
      subday.threads.map(t => t.messages.map(m => m.content)),
    );
    expect(even.threads[1]!.messages[5]!.createdAt).not.toEqual(subday.threads[1]!.messages[5]!.createdAt);
  });

  it.each(chatIds)('loads 20 questions for conversation %s, 2 per ability', chatId => {
    const questions = loadQuestions(DATA_DIR, '100K', chatId);
    expect(questions).toHaveLength(20);
    for (const ability of BEAM_ABILITIES) {
      expect(questions.filter(q => q.ability === ability)).toHaveLength(2);
    }
    for (const question of questions) {
      expect(question.question.length).toBeGreaterThan(0);
      expect(question.rubric.length).toBeGreaterThan(0);
      expect(question.reference.length).toBeGreaterThan(0);
    }
  });

  it('hands the actor the question and nothing that reveals the answer', () => {
    const conversation = loadConversation(DATA_DIR, '100K', '1');
    const question = loadQuestions(DATA_DIR, '100K', '1')[0]!;
    const actorQuestion = toActorQuestion(question, conversation);

    expect(Object.keys(actorQuestion).sort()).toEqual(['question', 'questionDate', 'questionId']);
    const serialized = JSON.stringify(actorQuestion);
    expect(serialized).not.toContain(question.reference);
    for (const item of question.rubric) expect(serialized).not.toContain(item);
  });
});
