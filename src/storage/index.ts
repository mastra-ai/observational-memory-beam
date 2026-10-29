/**
 * Vendored from mastra-ai/mastra @ f9fc28e7611c
 *   explorations/longmemeval/src/storage/index.ts
 *
 * These adapters are not published to npm — they exist only inside Mastra's
 * benchmark exploration — but the whole harness depends on them: they are what
 * lets a conversation's memory be snapshotted to JSON and rehydrated read-only
 * for each of its 20 questions, with no database anywhere.
 *
 * Kept as a verbatim copy so it can be re-diffed against upstream. Adapt here,
 * not at the call sites.
 */
export { BenchmarkStore } from './benchmark-store';
export { BenchmarkVectorStore } from './benchmark-vector';
export { PersistableInMemoryMemory } from './persistable-inmemory';

import { InMemoryStore } from '@mastra/core/storage';
import { PersistableInMemoryMemory } from './persistable-inmemory';

/**
 * A composite store whose memory domain is snapshot-able.
 *
 * Published `Memory` requires a full `MastraCompositeStore`, while OM and the
 * persist/hydrate cycle work against the memory domain alone. Swapping the
 * domain object into an otherwise stock `InMemoryStore` lets both hold the same
 * instance, so what OM observes is exactly what gets written to `om.json`.
 */
export function createBenchmarkStorage(options?: { readOnly: boolean }): {
  memoryStore: PersistableInMemoryMemory;
  storage: InMemoryStore;
} {
  const memoryStore = new PersistableInMemoryMemory(options);
  const storage = new InMemoryStore();
  storage.stores.memory = memoryStore;
  return { memoryStore, storage };
}
