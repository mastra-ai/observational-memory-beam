import { describe, expect, it } from 'vitest';

import { withSimulatedNow } from '../src/ingest/clock';

describe('clock', () => {
  it('pins the process to UTC, whatever zone the machine is in', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
    // OM parses its "Date: Jun 22, 2024" headers as local midnight
    expect(new Date('Jun 22, 2024').toISOString()).toBe('2024-06-22T00:00:00.000Z');
  });

  it('runs a callback at the simulated time', async () => {
    const at = new Date('2024-06-23T00:00:00.000Z');
    const seen = await withSimulatedNow(at, async () => new Date());
    expect(Math.abs(seen.getTime() - at.getTime())).toBeLessThan(1000);
  });
});
