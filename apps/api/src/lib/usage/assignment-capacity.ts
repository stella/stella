/**
 * Serialization and reconciliation for the member designation roster.
 *
 * Every writer that reads roster size before changing it — designation
 * (capacity check), release (so a racing designation cannot count a row
 * being released), and capacity reconciliation on configuration changes —
 * takes the same per-organization advisory lock first, so each outcome
 * describes the committed roster. Row locks are not an option: the
 * restrictive `no_update` RLS policies on the usage tables silently
 * filter rows out of `SELECT ... FOR UPDATE` for the app role.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { usageSeatAssignments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

/**
 * Namespace for the per-organization roster lock. `pg_advisory_xact_lock`
 * keys collide across unrelated advisory locks; the org-id hash is the
 * second key.
 */
const ASSIGNMENT_CAPACITY_LOCK_NAMESPACE = 0x5e_a7_ca_9a;

/** Held until the surrounding transaction commits. */
export const lockAssignmentCapacity = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${ASSIGNMENT_CAPACITY_LOCK_NAMESPACE}, hashtext(${organizationId}))`,
  );
};

/**
 * Drop designations beyond `capacity`, keeping the earliest-designated
 * members (deterministic id tiebreak). Callers hold the capacity lock.
 * Returns the number of rows removed.
 */
export const trimAssignmentsToCapacity = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  capacity: number,
): Promise<number> => {
  const excess = await tx
    .select({ id: usageSeatAssignments.id })
    .from(usageSeatAssignments)
    .where(eq(usageSeatAssignments.organizationId, organizationId))
    .orderBy(asc(usageSeatAssignments.createdAt), asc(usageSeatAssignments.id))
    .offset(capacity)
    .limit(LIMITS.usageAssignmentsMax);
  if (excess.length === 0) {
    return 0;
  }

  await tx.delete(usageSeatAssignments).where(
    inArray(
      usageSeatAssignments.id,
      excess.map((row) => row.id),
    ),
  );
  return excess.length;
};
