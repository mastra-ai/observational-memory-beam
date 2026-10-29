import { describe, expect, it } from 'vitest';
import {
  DATE_POLICIES,
  DEFAULT_DATE_POLICY,
  flattenDates,
  getDatePolicy,
  parseAnchor,
  questionDateFor,
  type AnchoredBatch,
} from '../src/data/dates';

/** Shaped like a real 100K chat: 3 batches, 26 turns, mixed 2/4/6 message turns. */
const batches: AnchoredBatch[] = [
  { anchor: parseAnchor('March-15-2024'), turnMessageCounts: Array.from({ length: 26 }, (_, i) => [4, 2, 6][i % 3]!) },
  { anchor: parseAnchor('April-05-2024'), turnMessageCounts: Array.from({ length: 26 }, () => 4) },
  { anchor: parseAnchor('April-25-2024'), turnMessageCounts: Array.from({ length: 26 }, () => 4) },
];

/** Worst case in the dataset: 10M-tier batch density. */
const denseBatches: AnchoredBatch[] = [
  { anchor: parseAnchor('March-15-2024'), turnMessageCounts: Array.from({ length: 600 }, () => 8) },
  { anchor: parseAnchor('March-16-2024'), turnMessageCounts: Array.from({ length: 600 }, () => 8) },
];

describe('parseAnchor', () => {
  it('parses BEAM anchors as UTC midnight', () => {
    expect(parseAnchor('March-15-2024').toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(parseAnchor('January-05-2025').toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });

  it('rejects anything that is not BEAM\'s format rather than guessing', () => {
    expect(() => parseAnchor('2024-03-15')).toThrow();
    expect(() => parseAnchor('Smarch-15-2024')).toThrow();
  });
});

describe('questionDateFor', () => {
  it('is one day after the final anchor, so every event is in the past', () => {
    expect(questionDateFor(batches.map(b => b.anchor)).toISOString()).toBe('2024-04-26T00:00:00.000Z');
  });
});

describe.each(Object.keys(DATE_POLICIES))('%s', id => {
  const policy = getDatePolicy(id);

  it('preserves the shape of its input', () => {
    const dates = policy.assign(batches);
    expect(dates.map(b => b.length)).toEqual([26, 26, 26]);
    expect(dates[0]!.map(t => t.length)).toEqual(batches[0]!.turnMessageCounts);
  });

  // The invariant every policy owes the observer. OM anchors temporal reasoning
  // on createdAt; a non-monotonic sequence corrupts it silently.
  it('assigns strictly increasing timestamps across the whole conversation', () => {
    const flat = flattenDates(policy.assign(batches)).map(d => d.getTime());
    expect(flat.every((t, i) => i === 0 || t > flat[i - 1]!)).toBe(true);
  });

  it('stays strictly increasing at 10M-tier turn density', () => {
    const flat = flattenDates(policy.assign(denseBatches)).map(d => d.getTime());
    expect(flat.every((t, i) => i === 0 || t > flat[i - 1]!)).toBe(true);
  });

  it('never places a message before its own batch anchor', () => {
    const dates = policy.assign(batches);
    dates.forEach((batch, i) => {
      for (const turn of batch) {
        for (const date of turn) expect(date.getTime()).toBeGreaterThanOrEqual(batches[i]!.anchor.getTime());
      }
    });
  });
});

describe('spread-subday@1 (the default)', () => {
  it('is the default policy', () => {
    expect(DEFAULT_DATE_POLICY).toBe('spread-subday@1');
  });

  // The property it exists for: BEAM's ground-truth dates are all batch anchors,
  // so a synthesized date that lands on a different day can only contradict them.
  it('keeps every message on its batch anchor\'s calendar day', () => {
    const dates = getDatePolicy('spread-subday@1').assign(batches);
    dates.forEach((batch, i) => {
      const anchorDay = batches[i]!.anchor.toISOString().slice(0, 10);
      for (const turn of batch) {
        for (const date of turn) expect(date.toISOString().slice(0, 10)).toBe(anchorDay);
      }
    });
  });

  it('holds that property at 10M-tier density too', () => {
    const dates = getDatePolicy('spread-subday@1').assign(denseBatches);
    dates.forEach((batch, i) => {
      const anchorDay = denseBatches[i]!.anchor.toISOString().slice(0, 10);
      for (const turn of batch) {
        for (const date of turn) expect(date.toISOString().slice(0, 10)).toBe(anchorDay);
      }
    });
  });
});

describe('spread-even@1', () => {
  it('uses the gap to the next anchor, so turns land between anchors', () => {
    const dates = getDatePolicy('spread-even@1').assign(batches);
    const lastTurnOfFirstBatch = dates[0]!.at(-1)!.at(-1)!;
    expect(lastTurnOfFirstBatch.getTime()).toBeLessThan(batches[1]!.anchor.getTime());
    // 26 turns over a 21-day gap puts the final turn well past the anchor day.
    expect(lastTurnOfFirstBatch.toISOString().slice(0, 10)).not.toBe('2024-03-15');
  });
});

describe('anchor-only@1', () => {
  it('leaves every message on the anchor day and invents no spread', () => {
    const dates = getDatePolicy('anchor-only@1').assign(batches);
    expect(dates[0]![0]![0]!.toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(dates[0]![0]![1]!.toISOString()).toBe('2024-03-15T00:00:05.000Z');
  });
});
