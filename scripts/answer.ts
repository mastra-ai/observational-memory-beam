/**
 * Step 2 of 3: answer every question of a tier from the memories step 1 built.
 *
 *   npx tsx scripts/answer.ts [tier] [i/n] [--judge]
 *
 * `--judge` grades each answer as soon as it is written, so steps 2 and 3 run as one.
 * A conversation whose answers all exist is skipped. `i/n` runs shard i of n, by
 * conversation. `BEAM_CONVERSATIONS=1,2,3` restricts the run to those chat ids.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { answerConversation } from '../src/answer/run';
import { writeJsonAtomic } from '../src/atomic-write';
import { answersDir, buildJudgeModel, describeRun, judgementsDir, RUN, snapshotPath } from '../src/config';
import { listConversations, loadConversation, loadQuestions } from '../src/data/loader';
import { BEAM_TIERS, type BeamTier } from '../src/data/types';
import { judgeAndRecord, judgementFile } from '../src/judge/record';
import { inShard, parseShard } from '../src/shard';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const tier = (positional[0] ?? '100K') as BeamTier;
if (!BEAM_TIERS.includes(tier)) throw new Error(`unknown tier ${tier}; one of ${BEAM_TIERS.join(', ')}`);
const shard = parseShard(positional[1]);
const judgeModel = args.includes('--judge') ? buildJudgeModel() : undefined;
const dataDir = process.env.BEAM_DATA_DIR ?? './data/beam';
const outDir = answersDir(tier);
mkdirSync(outDir, { recursive: true });
describeRun(outDir);
if (judgeModel) describeRun(judgementsDir(tier));
const fileFor = (questionId: string) => join(outDir, `${questionId.replaceAll('/', '_')}.json`);
const only = process.env.BEAM_CONVERSATIONS ? new Set(process.env.BEAM_CONVERSATIONS.split(',').map(s => s.trim())) : undefined;

console.log(`answer: observer=${RUN.observer} actor=${RUN.actor} → ${outDir}`);
for (const chatId of listConversations(dataDir, tier).filter((id, i) => inShard(i, shard) && (!only || only.has(id)))) {
  const questions = loadQuestions(dataDir, tier, chatId);
  if (questions.every(q => existsSync(fileFor(q.questionId)))) { console.log(`skip ${chatId} (answered)`); continue; }
  const snapshotDir = dirname(snapshotPath(tier, chatId));
  if (!existsSync(join(snapshotDir, 'om.json')) || !existsSync(join(snapshotDir, 'vectors.json')))
    throw new Error(`${chatId}: no memory in ${snapshotDir}; run scripts/ingest.ts first`);
  const conversation = loadConversation(dataDir, tier, chatId);
  const started = Date.now();
  console.log(`${conversation.conversationId}: ${questions.length} questions`);
  await answerConversation({
    conversation, questions, snapshotDir,
    observerModel: RUN.observer,
    actorModel: RUN.actor,
    onProgress: line => console.log(`  ${line}`),
    onAnswer: async answer => {
      writeJsonAtomic(fileFor(answer.questionId), { run: RUN, ...answer });
      if (!judgeModel || existsSync(judgementFile(tier, answer.questionId))) return;
      const question = questions.find(q => q.questionId === answer.questionId)!;
      const judged = await judgeAndRecord(tier, question, answer, judgeModel);
      console.log(`  judged ${answer.questionId} partial=${judged.scores.partial.toFixed(2)}`);
    },
  });
  console.log(`done ${chatId} in ${Math.round((Date.now() - started) / 1000)}s`);
}
console.log('answers complete');
// Every file is written; OM, the vector store and the HTTP agent can hold handles open, so leave explicitly.
process.exit(0);
