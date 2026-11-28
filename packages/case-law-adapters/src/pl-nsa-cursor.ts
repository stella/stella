// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: Moving the cursor encoder preserves its revision, shard and row format; decision parsing is unchanged.
import type { PlNsaSnapshot } from "./pl-nsa-dataset";

/** A position in the pinned revision; `shard === shards.length` is the end. */
export type PlNsaCursor = { shard: number; row: number };

export const encodePlNsaCursor = (
  { row, shard }: PlNsaCursor,
  snapshot: PlNsaSnapshot,
): string => `${snapshot.revision}:${shard}:${row}`;
