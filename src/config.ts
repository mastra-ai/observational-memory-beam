/**
 * The run configuration. Each step reads only the models it needs, and each
 * step's output is keyed by the models that produced it, so changing one model
 * re-runs one step:
 *
 *   ingest   snapshots/<tier>/<chat>/<observer>/om.json
 *   answer   answers/<tier>/<observer>/<actor>-v<run>/<question>.json
 *   judge    judgements/<tier>/<observer>/<actor>-v<run>/<judge>/<question>.json
 *
 * The Observer and the answering model are Mastra model-router ids
 * (`provider/model`, used exactly as written). The judge is an OpenRouter model id.
 * All three come from the environment, so two runs with different models can
 * share a checkout.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ModelRouterLanguageModel } from '@mastra/core/llm';

import { createOpenRouterModel } from './models/openrouter';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: the keys must already be in the environment */
}

const env = process.env;
export const RUN = {
  /** Writes and rewrites the notes (Observer and Reflector). Needs OPENROUTER_API_KEY. */
  observer: env.BEAM_OBSERVER ?? 'openrouter/google/gemini-3.8-flash',
  /** Answers the questions. Needs ANTHROPIC_API_KEY, or OPENROUTER_API_KEY with an `openrouter/…` id. */
  actor: env.BEAM_ACTOR ?? 'anthropic/claude-opus-5-5',
  /** Grades the answers, through OpenRouter. */
  judge: env.BEAM_JUDGE ?? 'google/gemini-3-flash-preview',
  /** Names a set of answers. Change it to answer the same memories again as a fresh set. */
  run: env.BEAM_RUN ?? '1',
};

/** The embedding model behind OM's search tool. */
export const EMBEDDER = 'openai/text-embedding-3-large';

export const snapshotPath = (tier: string, chatId: string) => `snapshots/${tier}/${chatId}/${RUN.observer}/om.json`;
export const answersDir = (tier: string) => `answers/${tier}/${RUN.observer}/${RUN.actor}-v${RUN.run}`;
export const judgementsDir = (tier: string) => `judgements/${tier}/${RUN.observer}/${RUN.actor}-v${RUN.run}/${RUN.judge}`;

/** Writes a README into an output directory saying which run produced it. */
export function describeRun(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'README.md');
  if (existsSync(path)) return;
  writeFileSync(
    path,
    [
      `# ${RUN.observer} / ${RUN.actor} v${RUN.run} / ${RUN.judge}`,
      '',
      `- observer: ${RUN.observer}`,
      `- answering model: ${RUN.actor}`,
      `- judge: ${RUN.judge}`,
      `- run: ${RUN.run}`,
      `- embedder: ${EMBEDDER}`,
      `- started: ${new Date().toISOString().slice(0, 16)}Z`,
      '',
    ].join('\n'),
  );
}

/** OM's Observer and Reflector, through Mastra's model router at the provider's defaults. */
export const buildObserverModel = () => new ModelRouterLanguageModel(RUN.observer);
export const buildJudgeModel = () => createOpenRouterModel(RUN.judge);
