/**
 * Step 1 of 3: ingest every conversation of a tier that does not yet have a snapshot.
 *
 *   npx tsx scripts/ingest.ts [tier] [i/n]
 *
 * Sequential within the process — the simulated clock is process-global.
 * Parallelism is `[i/n]` shards in separate processes, by conversation.
 * `BEAM_CONVERSATIONS=1,2,3` restricts to listed chat ids (a subset run).
 * `BEAM_SNAPSHOT_EVERY=n` (default 10) keeps a checkpoint every n batches, and
 * `BEAM_RESUME=1` continues an interrupted conversation from its last one.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BEAM_TIERS, type BeamTier } from '../src/data/types';
import { listConversations, loadConversation } from '../src/data/loader';
import { buildObserverModel, describeRun, RUN, snapshotPath } from '../src/config';
import { prepareConversation } from '../src/ingest/prepare';
import { inShard, parseShard } from '../src/shard';

const dataDir = process.env.BEAM_DATA_DIR ?? './data/beam';
const tier = (process.argv[2] ?? '100K') as BeamTier;
if (!BEAM_TIERS.includes(tier)) throw new Error(`unknown tier ${tier}; one of ${BEAM_TIERS.join(', ')}`);
const shard = parseShard(process.argv[3]);
const only = process.env.BEAM_CONVERSATIONS ? new Set(process.env.BEAM_CONVERSATIONS.split(',').map(s => s.trim())) : undefined;

for (const chatId of listConversations(dataDir, tier).filter((id, i) => inShard(i, shard) && (!only || only.has(id)))) {
  if (existsSync(snapshotPath(tier, chatId))) {
    console.log(`skip ${chatId} (snapshot exists)`);
    continue;
  }
  const conversation = loadConversation(dataDir, tier, chatId);
  const started = Date.now();
  console.log(`ingesting ${tier}/${chatId} (${conversation.threads.length} batch-threads)...`);
  const result = await prepareConversation({
    conversation,
    observerModel: buildObserverModel(),
    snapshotDir: './snapshots',
    config: RUN.observer,
    onProgress: p => console.log(`  batch ${p.batchNumber}: obs=${p.observation.tokens} tok`),
  });
  const memoryDir = join(snapshotPath(tier, chatId), '..');
  describeRun(memoryDir);
  // The checkpoints only exist to resume an interrupted run; the finished memory is om.json and vectors.json.
  for (const file of readdirSync(memoryDir)) if (/^batch-\d+(\.vectors)?\.json$/.test(file)) unlinkSync(join(memoryDir, file));
  console.log(`done ${chatId} in ${Math.round((Date.now() - started) / 1000)}s, ${result.messageCount} messages, observer=${RUN.observer}`);
}
console.log(`ALL ${tier} SNAPSHOTS READY`);
