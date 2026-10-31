import { and, eq, inArray, ne } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
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
 * Uses the stewardship lifecycle/member/matter prefix in shared mode, then
 * decides reach with a fresh statement while revocation remains fenced.
 *
 * Reads the rows directly rather than through the RLS access view, so the
 * answer is the same on a membership-scoped handle and on a handle pinned to
 * a stored matter.
 */
export const holdMemberAccessOnTx = async (
  tx: Transaction,
  { organizationId, userId, workspaceIds }: HoldMemberAccessOptions,
): Promise<MemberAccessHold> => {
  const requested = [...new Set(workspaceIds)];
  await lockMatterStewardship({
    tx,
    requests: [{ organizationId, workspaceIds: requested, userIds: [userId] }],
    mode: "share",
  });
  const organizationMember = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  if (organizationMember.length === 0) {
    return { type: "not-member" };
  }
  if (requested.length === 0) {
    return { type: "held", workspaceIds: [] };
  }
  const reachable = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, requested),
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
