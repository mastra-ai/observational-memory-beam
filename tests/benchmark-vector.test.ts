import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryVectorParams } from '@mastra/core/vector';
import { BenchmarkVectorStore } from '../src/storage/benchmark-vector';

const indexName = 'observations';
const queryVector = [1, 0];
const window = { $gt: '2023-08-10T00:00:00.000Z', $lt: '2023-08-22T00:00:00.000Z' };
const metadata = (resource: string, thread: string, day?: string) => ({
  resource_id: resource,
  thread_id: thread,
  ...(day ? { observed_at: `2023-08-${day}T00:00:00.000Z` } : {}),
});

describe('BenchmarkVectorStore query filters', () => {
  let store: BenchmarkVectorStore;

  beforeEach(async () => {
    store = new BenchmarkVectorStore();
    await store.createIndex({ indexName, dimension: 2 });
    await store.upsert({
      indexName,
      ids: ['other-resource', 'other-thread', 'too-late', 'start-boundary', 'end-boundary', 'missing-date', 'closure', 'reflection', 'wrong-date-type'],
      vectors: [[1, 0], [1, 0.01], [1, 0.02], [1, 0.03], [1, 0.04], [1, 0.05], [1, 0.1], [1, 0.2], [1, 0.06]],
      metadata: [
        metadata('other', 'target', '11'),
        metadata('user', 'other', '11'),
        metadata('user', 'target', '30'),
        metadata('user', 'target', '10'),
        metadata('user', 'target', '22'),
        metadata('user', 'target'),
        metadata('user', 'target', '11'),
        metadata('user', 'target', '21'),
        { ...metadata('user', 'target'), observed_at: 123 },
      ],
    });
  });

  afterEach(async () => { await store.close(); });

  it('applies resource, thread and date filters before top-K, preserving similarity order and scores', async () => {
    const all = await store.query({ indexName, queryVector, topK: 20 });
    const results = await store.query({
      indexName, queryVector, topK: 2,
      filter: { resource_id: 'user', thread_id: 'target', observed_at: window },
    });
    expect(results.map(r => r.id)).toEqual(['closure', 'reflection']);
    expect(results).toEqual(all.filter(r => ['closure', 'reflection'].includes(r.id)));
  });

  it.each([undefined, null, {}])('preserves unfiltered results for %j', async filter => {
    expect((await store.query({ indexName, queryVector, topK: 2, filter })).map(r => r.id))
      .toEqual(['other-resource', 'other-thread']);
  });

  it('supports inclusive date bounds and equality operators', async () => {
    const results = await store.query({ indexName, queryVector, topK: 20, filter: {
      resource_id: { $eq: 'user' }, thread_id: { $ne: 'other' },
      observed_at: { $gte: window.$gt, $lte: window.$lt },
    } });
    expect(results.map(r => r.id)).toEqual(['start-boundary', 'end-boundary', 'closure', 'reflection']);
  });

  it('supports numeric bounds and primitive equality without coercion', async () => {
    await store.upsert({ indexName, ids: ['number', 'string'], vectors: [[1, 0], [1, 0.1]], metadata: [
      { amount: 5, active: true, value: null }, { amount: '5', active: true, value: null },
    ] });
    const results = await store.query({ indexName, queryVector, filter: {
      amount: { $gt: 4, $lt: 6 }, active: true, value: null,
    } });
    expect(results.map(r => r.id)).toEqual(['number']);
  });

  it('returns fewer results or none without filling from excluded threads', async () => {
    const one = await store.query({ indexName, queryVector, topK: 10, filter: { thread_id: 'other' } });
    expect(one.map(r => r.id)).toEqual(['other-thread']);
    expect(await store.query({ indexName, queryVector, filter: { thread_id: 'absent' } })).toEqual([]);
  });

  it.each<QueryVectorParams['filter']>([
    { $or: [{ thread_id: 'target' }] },
    { thread_id: { $regex: 'target' } },
    { thread_id: { $in: ['target'] } },
  ])('rejects unsupported filters instead of silently broadening a search: %j', async filter => {
    await expect(store.query({ indexName, queryVector, filter })).rejects.toThrow('Unsupported benchmark vector filter');
  });

  it('validates every filter condition even when another condition matches no documents', async () => {
    await expect(store.query({ indexName, queryVector, filter: {
      resource_id: 'absent', thread_id: { $regex: 'target' },
    } })).rejects.toThrow('Unsupported benchmark vector filter');
  });

  it('isolates concurrent filtered queries without mutating a read-only snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beam-vector-filter-'));
    const file = join(dir, 'vectors.json');
    const reader = new BenchmarkVectorStore('read');
    try {
      await store.persist(file);
      const before = await readFile(file, 'utf8');
      await reader.hydrate(file);
      const [first, second] = await Promise.all([
        reader.query({ indexName, queryVector, filter: { thread_id: 'other' } }),
        reader.query({ indexName, queryVector, filter: { resource_id: 'other' } }),
      ]);
      expect(first.map(r => r.id)).toEqual(['other-thread']);
      expect(second.map(r => r.id)).toEqual(['other-resource']);
      expect((await reader.query({ indexName, queryVector, topK: 20 })).length).toBe(9);
      await reader.persist(file);
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await reader.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
