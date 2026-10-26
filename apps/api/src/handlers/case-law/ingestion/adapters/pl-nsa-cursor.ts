import type { PlNsaSnapshot } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";

/** A position in the pinned revision; `shard === shards.length` is the end. */
export type PlNsaCursor = { shard: number; row: number };

export const encodePlNsaCursor = (
  { row, shard }: PlNsaCursor,
  snapshot: PlNsaSnapshot,
): string => `${snapshot.revision}:${shard}:${row}`;
