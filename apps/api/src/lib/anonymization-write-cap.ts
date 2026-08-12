import { and, eq, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  anonymizationAllowlistEntries,
  anonymizationBlacklistEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";

/**
 * Cap enforcement for the anonymization term sets.
 *
 * Detection reads every term that applies to a document: a blacklist
 * miss under-masks, an allowlist miss over-masks. Those complete reads
 * (`boundedAll`) rest on the per-workspace and per-organization caps in
 * `LIMITS`, so the caps have to hold under concurrency, which a plain
 * count-then-insert does not. Two admins adding terms at the same
 * moment both read the pre-insert count, both find room, and both
 * insert; the same interleaving on the org-wide replace lets each
 * transaction delete only the rows its own snapshot saw and keep its
 * own, leaving the union of two full sets behind.
 *
 * Every cap-checked write therefore reads its set through one of the
 * helpers below, each of which takes a per-scope advisory transaction
 * lock first. The lock is released on commit or rollback, after the
 * prior writer's rows are visible, so the count a caller decides on
 * already includes every committed sibling. Binding the lock and the
 * read into one call is the point: a write path cannot read the set it
 * is about to extend without serializing against the other writers of
 * that set.
 *
 * Each path takes exactly one of these locks and never holds two, so
 * there is no acquisition order to get wrong.
 */

/**
 * Namespace for the anonymization cap locks. `pg_advisory_xact_lock`
 * keys are process-global, so a fixed first key keeps this rail clear
 * of unrelated advisory locks; the scope-id hash is the second key.
 */
const ANONYMIZATION_CAP_LOCK_NAMESPACE = 0x0a_11_0c_a7;

const lockAnonymizationScope = async (
  tx: Transaction,
  scopeId: string,
): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${ANONYMIZATION_CAP_LOCK_NAMESPACE}, hashtext(${scopeId}))`,
  );
};

/**
 * Headroom over the cap for the write path's own reads.
 *
 * The cap bounds what a replacement may WRITE. It does not bound what a
 * replacement may FIND: before the advisory lock above, two replacements of the
 * same scope could interleave and commit the union of two capped sets, so a set
 * persisted by an older deployment can sit above the cap today.
 *
 * Reading those at exactly the cap would make the panic unrecoverable in the
 * one place that can fix it. The replacement handler is the only API path that
 * deletes these rows, and it has to see every row to delete it, so a bound of
 * `max` would panic on read and leave the set stuck above the cap with no way
 * down short of editing the database by hand.
 *
 * Two capped sets is the worst case that race could leave, so the write path
 * reads at twice the cap: an over-cap set is visible, one successful
 * replacement converges it to at most the cap, and every read after that is
 * inside the steady-state bound. Beyond twice the cap the panic still fires,
 * because no sequence of serialized replacements can produce it.
 */
const WRITE_PATH_RECOVERY_FACTOR = 2;

/**
 * Workspace-scoped blacklist terms, serialized against concurrent
 * writers of the same workspace's set. The caller needs the canonicals
 * to deduplicate and the row count to check the cap, so the whole set
 * comes back; the bound probe makes the (unordered) read either
 * complete or a panic, never a truncated prefix.
 */
export const loadWorkspaceAnonymizationTermsForWrite = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  await lockAnonymizationScope(tx, workspaceId);

  return await boundedAll({
    invariant:
      "LIMITS.anonymizationBlacklistEntriesPerWorkspace, enforced by this read's callers, doubled so a set left over the cap by the pre-lock replacement race stays repairable",
    max:
      LIMITS.anonymizationBlacklistEntriesPerWorkspace *
      WRITE_PATH_RECOVERY_FACTOR,
    table: "anonymization_blacklist_entries",
    query: (limit) =>
      tx
        .select({
          id: anonymizationBlacklistEntries.id,
          canonical: anonymizationBlacklistEntries.canonical,
        })
        .from(anonymizationBlacklistEntries)
        .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId))
        .limit(limit),
  });
};

/**
 * Org-wide blacklist terms (`workspace_id IS NULL`), serialized against
 * concurrent replacements of the same organization's set. The caller
 * replaces the set wholesale, so it needs every row it is about to
 * delete or update.
 */
export const loadOrganizationAnonymizationTermsForWrite = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await lockAnonymizationScope(tx, organizationId);

  return await boundedAll({
    invariant:
      "LIMITS.anonymizationBlacklistEntriesPerOrganization, enforced by the org-wide replace body schema, doubled so a set left over the cap by the pre-lock replacement race stays repairable",
    max:
      LIMITS.anonymizationBlacklistEntriesPerOrganization *
      WRITE_PATH_RECOVERY_FACTOR,
    table: "anonymization_blacklist_entries",
    query: (limit) =>
      tx
        .select({
          id: anonymizationBlacklistEntries.id,
          canonical: anonymizationBlacklistEntries.canonical,
        })
        .from(anonymizationBlacklistEntries)
        .where(
          and(
            eq(anonymizationBlacklistEntries.organizationId, organizationId),
            isNull(anonymizationBlacklistEntries.workspaceId),
          ),
        )
        .limit(limit),
  });
};

/**
 * Size of a workspace's allowlist (workspace- and document-scoped rows
 * both carry the workspace id), serialized against concurrent writers
 * of the same set. The caller only decides whether one more row fits,
 * so the count is enough.
 */
export const countWorkspaceAnonymizationAllowlistForWrite = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<number> => {
  await lockAnonymizationScope(tx, workspaceId);

  return await tx.$count(
    anonymizationAllowlistEntries,
    eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
  );
};
