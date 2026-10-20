// A file sink for servers that have a disk: Node, Bun, Deno (with
// --allow-write). Kept apart from index.js so a Workers bundle never meets a
// `node:` import.
import { appendFile } from 'node:fs/promises';

/** Appends one JSON line per event. `mcplytics report <file>` reads it back. */
export function jsonl(path = 'mcplytics.jsonl') {
  let queue = Promise.resolve();
  return {
    write(events) {
      const lines = events.map(e => JSON.stringify(e) + '\n').join('');
      // One write at a time, so lines from concurrent calls never interleave.
      // A failed write rejects this call (onError sees it) but not the next.
      const job = queue.then(() => appendFile(path, lines));
      queue = job.catch(() => {});
      return job;
    },
  };
}
