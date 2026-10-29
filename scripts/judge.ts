/**
 * Step 3 of 3: judge every answer in answersDir that has no judgement yet.
 * A different judge is a different judgementsDir, so answers are never redone.
 *
 *   npx tsx scripts/judge.ts [tier] [i/n]     — shard i of n, by answer file
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { answersDir, buildJudgeModel, describeRun, judgementsDir } from '../src/config';
import { BEAM_TIERS, type BeamTier } from '../src/data/types';
import { listConversations, loadQuestions } from '../src/data/loader';
import { judgeAndRecord, judgementFile, type AnswerRecord } from '../src/judge/record';
import { inShard, parseShard } from '../src/shard';

const tier = (process.argv[2] ?? '100K') as BeamTier;
if (!BEAM_TIERS.includes(tier)) throw new Error(`unknown tier ${tier}`);
const shard = parseShard(process.argv[3]);
const dataDir = process.env.BEAM_DATA_DIR ?? './data/beam';
const inDir = answersDir(tier);

const questions = new Map(
  listConversations(dataDir, tier).flatMap(chatId =>
    loadQuestions(dataDir, tier, chatId).map(q => [q.questionId, q] as const),
  ),
);
const judgeModel = buildJudgeModel();
describeRun(judgementsDir(tier));
console.log(`judge: ${inDir} → ${judgementsDir(tier)}`);

const files = readdirSync(inDir)
  .filter(f => f.endsWith('.json'))
  .sort()
  .filter((_, i) => inShard(i, shard));
let done = 0;
for (const file of files) {
  const answer = JSON.parse(readFileSync(join(inDir, file), 'utf8')) as AnswerRecord & { questionId: string };
  if (existsSync(judgementFile(tier, answer.questionId))) continue;
  const question = questions.get(answer.questionId)!;
  const judged = await judgeAndRecord(tier, question, answer, judgeModel);
  done++;
  console.log(`  [${done}] ${answer.questionId} partial=${judged.scores.partial.toFixed(2)}`);
}
console.log(`judged ${done}; ${files.length} answers total`);
