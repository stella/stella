import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "bulk-row-insert",
  capability:
    "Inserting an unbounded row set whose inserted rows are not read back",
  owner: ["apps/api/src/lib/db/bulk-write.ts"],
  summary:
    "`insertInChunks` owns the batch size that keeps a multi-row insert under " +
    "PostgreSQL's 65,535 bind-parameter cap, and owns the one chunking loop " +
    "the codebase exempts from `scripts/db-await-in-loop.ts`. A caller that writes " +
    "its own loop pays a round trip per row or re-derives the cap per table; " +
    "callers pass the writer, so `values()` stays where the table is known and " +
    "drizzle's row inference is untouched. Scoped to writes whose result is " +
    "discarded: `lib/notifications.ts` chunks its own fan-out because it needs " +
    "the inserted rows back to decide which recipient streams to ping, and " +
    "sizes batches for a different reason (one announcement to a large firm). " +
    "Folding it in means teaching this owner to return rows; until then the " +
    "two are different capabilities rather than a bypassed one.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
