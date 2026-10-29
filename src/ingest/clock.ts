/**
 * Runs ingestion as if it were happening at a historical moment.
 *
 * Mastra's MessageList assigns each message a `createdAt` through
 * `generateCreatedAt`, which enforces monotonicity against the last timestamp it
 * saw. The first dated thing in a request is the agent's own system message,
 * stamped with wall-clock now — so every subsequent message dated 2024 is
 * "earlier than the last one" and gets clamped forward to now + 1ms. The result
 * is a 2024 conversation whose every observation is dated the day the benchmark
 * ran, silently destroying temporal_reasoning and event_ordering.
 *
 * Passing `metadata.createdAt` is necessary but not sufficient: it fixes what
 * gets persisted while OM still observes the clamped values. Moving the clock
 * itself fixes both, and additionally gives OM the correct "now" for the
 * relative-time annotations it writes into observations.
 *
 * Cost of this approach: the override is global to the process for its
 * duration, so two conversations must not be ingested concurrently *in the same
 * process*. Parallelism across conversations therefore has to be process-level.
 * That is no real loss — separate processes were already wanted to bound the
 * memory a single large conversation can hold.
 *
 * The process time zone is pinned to UTC, the zone every simulated time is in.
 * OM writes the Observer's day headers in local time and reads them back as
 * local midnight when it computes "N days ago" at answer time. West of UTC
 * every relative date comes out a day short, which fails day-exact answers.
 */
process.env.TZ = 'UTC';

const RealDate = Date;

let offsetMs = 0;

class SimulatedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...(args as [number]));
  }

  static override now(): number {
    return RealDate.now() + offsetMs;
  }
}

/**
 * Runs `fn` with the process clock shifted so that "now" reads as `simulatedNow`.
 *
 * The shift is an offset rather than a freeze, so time still advances during the
 * call and anything relying on elapsed time keeps working.
 */
export async function withSimulatedNow<T>(simulatedNow: Date, fn: () => Promise<T>): Promise<T> {
  const previousOffset = offsetMs;
  offsetMs = simulatedNow.getTime() - RealDate.now();
  globalThis.Date = SimulatedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    offsetMs = previousOffset;
    if (previousOffset === 0) globalThis.Date = RealDate;
  }
}

/** Temporarily leave simulated time for credential expiry/refresh checks. */
export async function withRealNow<T>(fn: () => Promise<T>): Promise<T> {
  const previousDate = globalThis.Date;
  globalThis.Date = RealDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = previousDate;
  }
}

/** Real wall-clock milliseconds, for measuring how long ingestion actually took. */
export function realNow(): number {
  return RealDate.now();
}
