/**
 * Date interpolation for BEAM conversations.
 *
 * BEAM anchors dates at *batch* level only — 3 to 10 anchors for a whole
 * conversation, carried on the user message that opens each batch. Mastra's OM
 * keys its temporal reasoning off per-message `createdAt`, so the harness has to
 * synthesize timestamps for every message in between.
 *
 * That synthesis is a benchmark parameter, not an implementation detail: it
 * changes what OM can say about *when* something happened, which is exactly what
 * the `temporal_reasoning` and `event_ordering` abilities grade. So it lives
 * behind a versioned, pluggable policy and every conversation records which
 * policy produced it.
 *
 * All arithmetic is UTC. Local time zones would make snapshots machine-dependent.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Offset between messages inside a turn, matching Mastra's LongMemEval harness. */
const MESSAGE_STEP_MS = 5 * SECOND;

/** Waking-hours window used by `spread-subday`: 09:00 to 21:00 UTC. */
const SUBDAY_WINDOW_START_MS = 9 * HOUR;
const SUBDAY_WINDOW_MS = 12 * HOUR;

/** Span assumed for a conversation that has only one batch, so there is no gap to divide. */
const SINGLE_BATCH_SPAN_MS = DAY;

/**
 * A batch reduced to what a date policy needs: when it starts, and how many
 * messages each of its turns holds.
 */
export interface AnchoredBatch {
  anchor: Date;
  /** One entry per turn; the value is that turn's message count. */
  turnMessageCounts: number[];
}

/**
 * Assigned timestamps, shaped like the input: `dates[batch][turn][message]`.
 */
export type AssignedDates = Date[][][];

export interface DatePolicy {
  /** Versioned id, e.g. "spread-subday@1". Recorded on every conversation. */
  readonly id: string;
  readonly description: string;
  assign(batches: AnchoredBatch[]): AssignedDates;
}

/**
 * Parses BEAM's anchor format, e.g. "March-15-2024", to a UTC midnight Date.
 *
 * Deliberately strict: BEAM uses exactly one format across all four tiers, so a
 * parse failure means the dataset changed and the run should stop, not guess.
 */
export function parseAnchor(anchor: string): Date {
  const match = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(anchor.trim());
  if (!match) throw new Error(`Unrecognized BEAM time_anchor: ${JSON.stringify(anchor)}`);
  const [, monthName, day, year] = match;
  const month = MONTHS.indexOf(monthName!.toLowerCase());
  if (month < 0) throw new Error(`Unrecognized month in time_anchor: ${JSON.stringify(anchor)}`);
  const date = new Date(Date.UTC(Number(year), month, Number(day)));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time_anchor: ${JSON.stringify(anchor)}`);
  return date;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * The synthesized "now" every question about a conversation is asked at.
 *
 * One day after the final anchor: late enough that every event is in the past
 * (so "how long ago" questions have a defined answer), close enough that
 * relative-time phrasing stays natural.
 */
export function questionDateFor(anchors: Date[]): Date {
  const last = anchors[anchors.length - 1];
  if (!last) throw new Error('Cannot derive a question date from a conversation with no anchors');
  return new Date(last.getTime() + DAY);
}

/**
 * Spreads `count` message timestamps starting at `start`, stepping by
 * `MESSAGE_STEP_MS` but compressing if that would overrun `available`.
 *
 * Compression matters at the 10M tier, where batches hold enough turns that the
 * per-turn slice can get short. Without it, a turn's last message could land
 * after the next turn's first, breaking global ordering.
 */
function spreadMessages(start: number, count: number, available: number): Date[] {
  const step = Math.min(MESSAGE_STEP_MS, Math.floor(available / (count + 1)) || 1);
  return Array.from({ length: count }, (_, i) => new Date(start + i * step));
}

/**
 * Assigns turn start times from a per-batch span, then spreads messages inside
 * each turn. Shared by every policy; they differ only in the span they hand over.
 */
function assignWithSpans(batches: AnchoredBatch[], spanOf: (batch: AnchoredBatch, index: number) => [number, number]): AssignedDates {
  return batches.map((batch, batchIndex) => {
    const [spanStart, spanMs] = spanOf(batch, batchIndex);
    const turnCount = batch.turnMessageCounts.length;
    const turnSpacing = turnCount > 0 ? spanMs / turnCount : 0;
    return batch.turnMessageCounts.map((messageCount, turnIndex) =>
      spreadMessages(Math.round(spanStart + turnIndex * turnSpacing), messageCount, Math.round(turnSpacing)),
    );
  });
}

/**
 * Every turn in a batch gets that batch's anchor; messages step by 5s from there.
 *
 * The null policy — it synthesizes no dates at all beyond ordering. Useful as a
 * control: any temporal result that only appears under an interpolating policy
 * is a property of the interpolation, not of the memory system.
 */
const anchorOnly: DatePolicy = {
  id: 'anchor-only@1',
  description: 'All turns in a batch share the batch anchor; messages step 5s.',
  assign(batches) {
    return batches.map(batch => {
      let cursor = batch.anchor.getTime();
      return batch.turnMessageCounts.map(messageCount => {
        const dates = Array.from({ length: messageCount }, (_, i) => new Date(cursor + i * MESSAGE_STEP_MS));
        cursor += messageCount * MESSAGE_STEP_MS;
        return dates;
      });
    });
  },
};

/**
 * Turns spread evenly across the whole gap to the next anchor.
 *
 * Maximum temporal resolution, at a cost: BEAM's rubrics are generated from a
 * plan that only knows batch anchors, so every date in the ground truth *is* an
 * anchor. A turn placed mid-gap gets a date no rubric ever refers to.
 */
const spreadEven: DatePolicy = {
  id: 'spread-even@1',
  description: 'Turns spread evenly across [anchor_i, anchor_i+1); last batch reuses the previous span.',
  assign(batches) {
    return assignWithSpans(batches, (batch, i) => {
      const next = batches[i + 1];
      if (next) return [batch.anchor.getTime(), next.anchor.getTime() - batch.anchor.getTime()];
      const previous = batches[i - 1];
      const span = previous ? batch.anchor.getTime() - previous.anchor.getTime() : SINGLE_BATCH_SPAN_MS;
      return [batch.anchor.getTime(), span];
    });
  },
};

/**
 * Turns spread across waking hours *within* the anchor's own day.
 *
 * The default. Timestamps stay distinct and ordered, so intra-batch sequence is
 * legible to the observer, but every message's calendar date is still its batch
 * anchor — so interpolation can never contradict a rubric.
 */
const spreadSubday: DatePolicy = {
  id: 'spread-subday@1',
  description: 'Turns spread across 09:00-21:00 UTC on the batch anchor day; dates never leave the anchor.',
  assign(batches) {
    return assignWithSpans(batches, batch => [batch.anchor.getTime() + SUBDAY_WINDOW_START_MS, SUBDAY_WINDOW_MS]);
  },
};

export const DATE_POLICIES: Record<string, DatePolicy> = {
  [anchorOnly.id]: anchorOnly,
  [spreadEven.id]: spreadEven,
  [spreadSubday.id]: spreadSubday,
};

export const DEFAULT_DATE_POLICY = spreadSubday.id;

export function getDatePolicy(id: string = DEFAULT_DATE_POLICY): DatePolicy {
  const policy = DATE_POLICIES[id];
  if (!policy) {
    throw new Error(`Unknown date policy ${JSON.stringify(id)}. Available: ${Object.keys(DATE_POLICIES).join(', ')}`);
  }
  return policy;
}

/**
 * Flattens assigned dates to a single ordered list. Exported for tests, which
 * assert the invariant every policy owes the observer: timestamps strictly
 * increase across the entire conversation.
 */
export function flattenDates(dates: AssignedDates): Date[] {
  return dates.flat(2);
}
