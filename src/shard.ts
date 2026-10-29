/**
 * Process-level parallelism. The simulated clock is global to a process, so
 * concurrency across conversations means separate processes; each takes the
 * items whose index modulo `count` equals its `index`. `i/n` on the command
 * line, e.g. `0/4`; absent means everything.
 */
export interface Shard {
  index: number;
  count: number;
}

export function parseShard(arg: string | undefined): Shard {
  if (!arg) return { index: 0, count: 1 };
  const [index = NaN, count = NaN] = arg.split('/').map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`bad shard "${arg}", want i/n with 0 <= i < n`);
  }
  return { index, count };
}

export const inShard = (i: number, shard: Shard): boolean => i % shard.count === shard.index;
