import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

// Entities-per-workspace cap checks are a classic count-then-insert
// race: two concurrent creations can each read a count under the
// limit and both insert, pushing the workspace past
// `LIMITS.entitiesCount`. Placing the count and insert in the same
// transaction does NOT close this window on its own — at READ
// COMMITTED, two concurrent transactions each take their own
// snapshot per statement and neither sees the other's uncommitted
// insert, so both can read a count below the limit.
//
// `pg_advisory_xact_lock` serializes the count-then-insert sequence
// per workspace: the second concurrent transaction blocks until the
// first commits (or rolls back), at which point its own count
// reflects the first transaction's insert. The lock is held for the
// transaction's lifetime and releases automatically at COMMIT or
// ROLLBACK.
//
// Keyed with an `entity-cap:` prefix so this lock domain never
// collides with unrelated advisory locks already taken on the same
// workspace id elsewhere (e.g. property writes, time-entry bumps).
export const acquireWorkspaceEntityCapLock = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('entity-cap:' || ${workspaceId}))`,
  );
};
