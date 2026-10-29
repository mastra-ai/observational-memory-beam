/**
 * Prints the scores for a tier from its judgements.
 *
 *   npx tsx scripts/report.ts [tier]
 *
 * Partial credit (a half counts as a half, as the BEAM paper describes) is the
 * headline; strict gives credit only for a full point on each rubric item.
 */
import { judgementsDir } from '../src/config';
import { BEAM_TIERS, type BeamTier } from '../src/data/types';
import { aggregate, loadRecords, renderReport } from '../src/report/aggregate';

const tier = (process.argv[2] ?? '100K') as BeamTier;
if (!BEAM_TIERS.includes(tier)) throw new Error(`unknown tier ${tier}; one of ${BEAM_TIERS.join(', ')}`);
console.log(renderReport(aggregate(loadRecords(judgementsDir(tier)))));
