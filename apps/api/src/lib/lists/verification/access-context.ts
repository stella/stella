import { and, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces, workspaceMembers } from "@/api/db/schema";
import { env } from "@/api/env";
import { resolveFeatureAccess } from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { ListVerificationAccessResult } from "@/api/lib/lists/verification/access";

type VerificationWorkspaceAccessOptions = {
  organizationRole: string | null;
  workspaceMemberId: string | null;
  workspaceStatus: string | null;
  clientId: string | null;
};

const canExecuteListVerificationInWorkspace = ({
  organizationRole,
  workspaceMemberId,
  workspaceStatus,
  clientId,
}: VerificationWorkspaceAccessOptions): boolean =>
  workspaceStatus === "active" &&
  (workspaceMemberId !== null || clientId !== null) &&
  canWriteWorkspaceEntities({ organizationRole, workspaceMemberId });

type ResolveListVerificationAccessArgs = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  userId: string | null;
  grants?: FeatureAccessGrants | undefined;
  workspaceId?: SafeId<"workspace">;
};

export const resolveListVerificationAccess = async ({
  tx,
  organizationId,
  userId,
  grants = env.API_FEATURE_ACCESS_GRANTS,
  workspaceId,
}: ResolveListVerificationAccessArgs): Promise<ListVerificationAccessResult> => {
  if (
    !isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS") ||
    (grants[LIST_VERIFICATION_FEATURE_ID]?.length ?? 0) === 0 ||
    userId === null
  ) {
    return { status: "unavailable" };
  }
  if (workspaceId === undefined) {
    const decision = await resolveFeatureAccess({
      tx,
      organizationId,
      userId,
      featureId: LIST_VERIFICATION_FEATURE_ID,
      grants,
    });
    return decision.status === "enabled"
      ? { status: "available", proof: decision.proof }
      : { status: "unavailable" };
  }
  const identity = (
    await tx
      .select({
        role: member.role,
        workspaceId: workspaces.id,
        workspaceStatus: workspaces.status,
        clientId: workspaces.clientId,
        workspaceMemberId: workspaceMembers.id,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .leftJoin(
        workspaces,
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.organizationId, member.organizationId),
        ),
      )
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, member.userId),
        ),
      )
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
          isNull(user.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  const workspaceAllowed =
    identity?.workspaceId === workspaceId &&
    canExecuteListVerificationInWorkspace({
      organizationRole: identity.role,
      workspaceMemberId: identity.workspaceMemberId,
      workspaceStatus: identity.workspaceStatus,
      clientId: identity.clientId,
    });
  if (identity === undefined || !workspaceAllowed) {
    return { status: "unavailable" };
  }
  const decision = await resolveFeatureAccess({
    tx,
    organizationId,
    userId,
    featureId: LIST_VERIFICATION_FEATURE_ID,
    grants,
  });
  return decision.status === "enabled"
    ? { status: "available", proof: decision.proof }
    : { status: "unavailable" };
};
