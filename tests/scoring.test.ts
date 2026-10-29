import { describe, expect, it } from 'vitest';
import type { LanguageModelV2 } from '@ai-sdk/provider';

import type { BeamQuestion } from '../src/data/types';
import { judgeAnswer } from '../src/judge/beam-metric';
import { aggregate, renderReport, type QuestionRecord } from '../src/report/aggregate';

/** A grader that returns a fixed reply for each rubric item, in order. */
function fakeJudge(replies: string[]): LanguageModelV2 {
  let call = 0;
  return {
    specificationVersion: 'v2', provider: 'test', modelId: 'fake', supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: replies[call++ % replies.length]! }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    },
    async doStream() { throw new Error('not used'); },
  };
}

const question = {
  questionId: '100K/1/information_extraction/0', conversationId: '100K/1', ability: 'information_extraction',
  question: 'Which version?', rubric: ['should state: 4.35.0', 'should mention: Hugging Face'],
} as unknown as BeamQuestion;

describe('judgeAnswer', () => {
  it('snaps each rubric item to 0, 0.5 or 1 and averages them', async () => {
    const judged = await judgeAnswer({ question, hypothesis: 'x', judgeModel: fakeJudge(['{"score": 1, "reason": "ok"}', '{"score": 0.5, "reason": "half"}']) });
    expect(judged.judgements.map(j => j.score)).toEqual([1, 0.5]);
    expect(judged.scores.partial).toBeCloseTo(0.75);
    // Strict gives credit only for a full 1 on an item: half credit counts as nothing.
    expect(judged.scores.strict).toBeCloseTo(0.5);
  });

  it('reads the score out of fenced or chatty output', async () => {
    const judged = await judgeAnswer({ question, hypothesis: 'x', judgeModel: fakeJudge(['Sure!\n```json\n{"score": 1.0, "reason": "r"}\n```', 'score: not json']) });
    expect(judged.judgements[0]!.score).toBe(1);
    expect(judged.judgements[1]!.score).toBe(0);
  });
});

describe('aggregate', () => {
  const record = (ability: QuestionRecord['ability'], partial: number, strict: number): QuestionRecord =>
    ({ questionId: `100K/1/${ability}/0`, ability, hypothesis: '', scores: { partial, strict } });

  it('averages per ability first, then across abilities', () => {
    const report = aggregate([record('abstention', 1, 1), record('abstention', 0, 0), record('summarization', 0.5, 0)]);
    expect(report.abilities.map(a => [a.ability, a.mean.partial])).toEqual([['abstention', 0.5], ['summarization', 0.5]]);
    // Ability-weighted: (0.5 + 0.5) / 2, not the question-weighted 0.5.
    expect(report.overall.partial).toBeCloseTo(0.5);
    expect(renderReport(report)).toContain('OVERALL');
  });
});
