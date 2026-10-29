/**
 * Aggregates per-question result files into the tables a result gets quoted
 * from. One canonical implementation, so every number in a writeup traces to
 * the same arithmetic.
 *
 * Aggregation follows BEAM: mean over a question's rubric nuggets (already done
 * at judge time), mean over questions per ability, mean over abilities for the
 * overall. The overall is therefore ability-weighted, not question-weighted —
 * with 2 questions per ability per conversation these coincide, but the order
 * is stated because it matters the moment any question is dropped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BEAM_ABILITIES, type BeamAbility, type ScoringMode } from '../data/types';

export interface QuestionRecord {
  questionId: string;
  conversationId?: string;
  ability: BeamAbility;
  hypothesis: string;
  promptVersion?: string;
  scores: Record<ScoringMode, number>;
  answerContextTokens?: number;
  observationTokens?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AbilityRow {
  ability: BeamAbility;
  n: number;
  mean: Record<ScoringMode, number>;
  /** Standard deviation of question scores, headline mode. */
  sd: number;
  /** Half-width of a normal-approximation 95% interval, headline mode. */
  ci95: number;
}

export interface Report {
  questions: number;
  conversations: number;
  abilities: AbilityRow[];
  overall: Record<ScoringMode, number>;
  telemetry: {
    meanAnswerContextTokens: number;
    meanObservationTokens: number;
    meanLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

const MODES: ScoringMode[] = ['partial', 'strict'];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function loadRecords(dir: string): QuestionRecord[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as QuestionRecord);
}

export function aggregate(records: QuestionRecord[]): Report {
  const abilities: AbilityRow[] = [];

  for (const ability of BEAM_ABILITIES) {
    const rows = records.filter(r => r.ability === ability);
    if (rows.length === 0) continue;
    const headline = rows.map(r => r.scores.partial);
    const m = mean(headline);
    const sd = Math.sqrt(mean(headline.map(x => (x - m) ** 2)));
    abilities.push({
      ability,
      n: rows.length,
      mean: Object.fromEntries(MODES.map(mode => [mode, mean(rows.map(r => r.scores[mode]))])) as Record<
        ScoringMode,
        number
      >,
      sd,
      ci95: rows.length > 1 ? (1.96 * sd) / Math.sqrt(rows.length) : 1,
    });
  }

  const conversations = new Set(records.map(r => r.conversationId ?? r.questionId.split('/').slice(0, 2).join('/')));

  return {
    questions: records.length,
    conversations: conversations.size,
    abilities,
    overall: Object.fromEntries(
      MODES.map(mode => [mode, mean(abilities.map(row => row.mean[mode]))]),
    ) as Record<ScoringMode, number>,
    telemetry: {
      meanAnswerContextTokens: mean(records.map(r => r.answerContextTokens ?? 0)),
      meanObservationTokens: mean(records.map(r => r.observationTokens ?? 0)),
      meanLatencyMs: mean(records.map(r => r.latencyMs ?? 0)),
      totalInputTokens: records.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
      totalOutputTokens: records.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    },
  };
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`questions: ${report.questions}   conversations: ${report.conversations}`);
  lines.push('');
  lines.push('ability                      n   partial  ±95%   strict');
  for (const row of report.abilities) {
    lines.push(
      `${row.ability.padEnd(26)} ${String(row.n).padStart(3)}   ${row.mean.partial.toFixed(3)}  ±${row.ci95.toFixed(2)}   ${row.mean.strict.toFixed(3)}`,
    );
  }
  lines.push('');
  lines.push(
    `OVERALL (mean of abilities)      ${report.overall.partial.toFixed(3)}         ${report.overall.strict.toFixed(3)}`,
  );
  lines.push('');
  lines.push(
    `telemetry: actor read ${Math.round(report.telemetry.meanAnswerContextTokens)} tok mean (observations ${Math.round(report.telemetry.meanObservationTokens)}) · latency ${Math.round(report.telemetry.meanLatencyMs)} ms mean · actor tokens ${report.telemetry.totalInputTokens.toLocaleString()} in / ${report.telemetry.totalOutputTokens.toLocaleString()} out`,
  );
  return lines.join('\n');
}
