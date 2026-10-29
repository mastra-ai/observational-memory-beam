import { renameSync, writeFileSync } from 'node:fs';

/**
 * Write to a sibling temp file and rename into place. Every resumable step
 * treats "file exists" as "done", so a crash mid-write must leave nothing at
 * the final path.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}
