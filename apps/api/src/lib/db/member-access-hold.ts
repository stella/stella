import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
 * Locks the rows that decide that access `FOR SHARE`: the organization
 * `member` row and, per requested matter, the `workspace_members` row, or the
 * client matter itself when the member's organization role reaches every
 * client matter. Removing a member or changing their role deletes or updates
 * one of those rows, which waits for `tx` to finish; a removal that committed
 * first is reported here. Work done in `tx` after this call therefore happens
 * either entirely before a removal or not at all.
 *
 * Reads the rows directly rather than through the RLS access view, so the
 * answer is the same on a membership-scoped handle and on a handle pinned to
 * a stored matter.
 */
export const holdMemberAccessOnTx = async (
  tx: Transaction,
  { organizationId, userId, workspaceIds }: HoldMemberAccessOptions,
): Promise<MemberAccessHold> => {
  // Lock order: `member`, then `workspace_members`, then `workspaces`, the
  // same order account deletion removes them in.
  const organizationMember = (
    await tx
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1)
      .for("share")
  ).at(0);
  if (organizationMember === undefined) {
    return { type: "not-member" };
  }
  const requested = [...new Set(workspaceIds)];
  if (requested.length === 0) {
    return { type: "held", workspaceIds: [] };
  }

  const assigned = await tx
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        inArray(workspaceMembers.workspaceId, requested),
        eq(workspaces.organizationId, organizationId),
        ne(workspaces.status, "deleting"),
      ),
    )
    .for("share", { of: workspaceMembers });
  const held = new Set(assigned.map((row) => row.workspaceId));
  const unassigned = requested.filter((id) => !held.has(id));
  const reachesClientMatters = CLIENT_MATTER_ADMIN_ROLES.some(
    (role) => role === organizationMember.role,
  );
  if (unassigned.length > 0 && reachesClientMatters) {
    const clientMatters = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          inArray(workspaces.id, unassigned),
          eq(workspaces.organizationId, organizationId),
          isNotNull(workspaces.clientId),
          ne(workspaces.status, "deleting"),
        ),
      )
      .for("share");
    for (const { id } of clientMatters) {
      held.add(id);
    }
  }
  return {
    type: "held",
    workspaceIds: requested.filter((id) => held.has(id)),
  };
};
