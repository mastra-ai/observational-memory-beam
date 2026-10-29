/**
 * Judges one answer and writes its judgement record. The single path behind
 * `scripts/judge.ts` and the `--judge` flag of `scripts/answer.ts`, so both
 * produce identical files in the same place.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Answer } from '../answer/run';
import { writeJsonAtomic } from '../atomic-write';
import { judgementsDir, RUN } from '../config';
import type { BeamQuestion } from '../data/types';
import { judgeAnswer, type JudgeResult } from './beam-metric';

export const judgementFile = (tier: string, questionId: string) =>
  join(judgementsDir(tier), `${questionId.replaceAll('/', '_')}.json`);

/** The answer fields a judgement record carries forward; an answer file has all of them. */
export type AnswerRecord = Pick<
  Answer,
  'ability' | 'hypothesis' | 'promptVersion' | 'answerContextTokens' | 'observationTokens' | 'latencyMs' | 'inputTokens' | 'outputTokens'
>;

export async function judgeAndRecord(
  tier: string,
  question: BeamQuestion,
  answer: AnswerRecord,
  judgeModel: unknown,
): Promise<JudgeResult> {
  const judged = await judgeAnswer({ question, hypothesis: answer.hypothesis, judgeModel });
  mkdirSync(judgementsDir(tier), { recursive: true });
  // Telemetry travels with the judgement so the report needs only this directory.
  writeJsonAtomic(judgementFile(tier, question.questionId), {
    run: RUN,
    conversationId: question.conversationId,
    ability: answer.ability,
    hypothesis: answer.hypothesis,
    promptVersion: answer.promptVersion,
    answerContextTokens: answer.answerContextTokens,
    observationTokens: answer.observationTokens,
    latencyMs: answer.latencyMs,
    ...judged,
    // The report's token telemetry is about the answering model.
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    judgeInputTokens: judged.inputTokens,
    judgeOutputTokens: judged.outputTokens,
  });
  return judged;
}
