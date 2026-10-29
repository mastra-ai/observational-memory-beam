/**
 * Judges an answer against its rubric and scores it two ways.
 *
 * Each rubric item is judged independently, exactly as BEAM does, and the
 * question's score is the mean over items. `partial` is the paper's stated
 * method and the headline; `strict` gives credit only for a full 1 on an item.
 * A third, bug-for-bug reproduction of BEAM's released scorer used to live
 * here; it was dropped because that scorer is broken in ways no number should
 * inherit (see `prompt.ts`), and the deviation is disclosed instead.
 */
import { generateText } from 'ai';

import type { BeamQuestion, RubricJudgement, RubricScore, ScoringMode } from '../data/types';
import { BEAM_JUDGE_PROMPT } from './prompt';

export interface JudgeOptions {
  question: BeamQuestion;
  hypothesis: string;
  judgeModel: unknown;
}

export interface JudgeResult {
  questionId: string;
  judgements: RubricJudgement[];
  scores: Record<ScoringMode, number>;
  inputTokens: number;
  outputTokens: number;
}

/** Snaps a judge's float to BEAM's three-point scale. */
function toRubricScore(raw: unknown): RubricScore {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(value)) return 0;
  if (value >= 0.75) return 1;
  if (value >= 0.25) return 0.5;
  return 0;
}

/**
 * Extracts the judge's JSON. Models wrap it in prose or fences often enough that
 * BEAM itself depends on `json_repair`; the last balanced object wins.
 */
function parseJudgeJson(text: string): { score: unknown; reason?: string } {
  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      /* fall through to the regex below */
    }
  }
  const loose = /"score"\s*:\s*"?([0-9.]+)"?/.exec(fenced);
  return { score: loose?.[1] ?? 0, reason: text.slice(0, 300) };
}

function buildPrompt(question: BeamQuestion, item: string, hypothesis: string): string {
  return BEAM_JUDGE_PROMPT.replace('<rubric_item>', item)
    .replace('<llm_response>', hypothesis)
    // BEAM's released code leaves this placeholder unsubstituted; we fill it.
    .replace('<question>', question.question);
}

const mean = (judgements: RubricJudgement[], fn: (score: RubricScore) => number) =>
  judgements.reduce((total, j) => total + fn(j.score), 0) / (judgements.length || 1);

/**
 * Nuggets are judged concurrently, a few at a time. Each is an independent
 * call, so a question costs about one round trip instead of one per nugget.
 * The cap keeps a handful of shards from opening dozens of CLI processes at
 * once against one subscription.
 */
const NUGGET_CONCURRENCY = 4;

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function judgeAnswer(options: JudgeOptions): Promise<JudgeResult> {
  const { question, hypothesis, judgeModel } = options;

  const results = await mapWithLimit(question.rubric, NUGGET_CONCURRENCY, async item => {
    const response = await generateText({
      model: judgeModel as never,
      prompt: buildPrompt(question, item, hypothesis),
      temperature: 0,
    });
    const parsed = parseJudgeJson(response.text);
    return {
      judgement: { item, score: toRubricScore(parsed.score), reason: String(parsed.reason ?? '') },
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  });
  const judgements = results.map(r => r.judgement);
  const inputTokens = results.reduce((n, r) => n + r.inputTokens, 0);
  const outputTokens = results.reduce((n, r) => n + r.outputTokens, 0);

  return {
    questionId: question.questionId,
    judgements,
    scores: {
      partial: mean(judgements, score => score),
      strict: mean(judgements, score => (score === 1 ? 1 : 0)),
    },
    inputTokens,
    outputTokens,
  };
}
