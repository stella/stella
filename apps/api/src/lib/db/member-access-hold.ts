import { and, eq, inArray, ne } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessAssignments,
  lockMatterAccessWorkspaceRows,
  lockMemberAccessRow,
} from "@/api/lib/db/aggregate-lock";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

type HoldMemberAccessOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** Matters the transaction's work depends on; empty for organization-only
   *  work. */
  workspaceIds: readonly SafeId<"workspace">[];
};

export type MemberAccessHold =
  | { type: "not-member" }
  /** `workspaceIds` is the subset of the requested matters still reachable;
   *  a caller that needs every one compares lengths. */
  | { type: "held"; workspaceIds: readonly SafeId<"workspace">[] };

/**
 * Hold a member's current access for the rest of `tx`.
 *
 * Locks the organization member and requested matter assignments `FOR SHARE`.
 * Unassigned matters reached through the database rule also hold their matter
 * row. The final reach decision uses a later statement and only identities
 * covered by those locks, so it sees changes committed before acquisition.
 *
 * Reads the rows directly rather than through the RLS access view, so the
 * answer is the same on a membership-scoped handle and on a handle pinned to
 * a stored matter.
 */
export const holdMemberAccessOnTx = async (
  tx: Transaction,
  { organizationId, userId, workspaceIds }: HoldMemberAccessOptions,
): Promise<MemberAccessHold> => {
  const scope = { tx, organizationId, userId, mode: "share" } as const;
  const organizationMember = await lockMemberAccessRow(scope);
  if (organizationMember === undefined) {
    return { type: "not-member" };
  }
  const requested = [...new Set(workspaceIds)];
  if (requested.length === 0) {
    return { type: "held", workspaceIds: [] };
  }
  const assigned = await lockMatterAccessAssignments({
    ...scope,
    workspaceIds: requested,
  });
  const covered = new Set(assigned.map((row) => row.workspaceId));
  const matterRows = await lockMatterAccessWorkspaceRows({
    ...scope,
    workspaceIds: requested.filter((id) => !covered.has(id)),
    where: and(
      ne(workspaces.status, "deleting"),
      memberReachesMatterSql({ organizationId, userId }, workspaces.id),
    ),
  });
  for (const { id } of matterRows) {
    covered.add(id);
  }
  const candidates = requested.filter((id) => covered.has(id));
  if (candidates.length === 0) {
    return { type: "held", workspaceIds: [] };
  }
  const reachable = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, candidates),
        eq(workspaces.organizationId, organizationId),
        ne(workspaces.status, "deleting"),
        memberReachesMatterSql({ organizationId, userId }, workspaces.id),
      ),
    );
  const held = new Set(reachable.map(({ id }) => id));
  return {
    type: "held",
    workspaceIds: requested.filter((id) => held.has(id)),
  };
};
