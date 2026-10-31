import { and, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import { readFeatureAccessGrants } from "@/api/env-feature-access";
import { resolveFeatureAccess } from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { ListVerificationAccessResult } from "@/api/lib/lists/verification/access";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

type VerificationWorkspaceAccessOptions = {
  organizationRole: string | null;
  reachesMatter: boolean;
  workspaceStatus: string | null;
};

const canExecuteListVerificationInWorkspace = ({
  organizationRole,
  reachesMatter,
  workspaceStatus,
}: VerificationWorkspaceAccessOptions): boolean =>
  workspaceStatus === "active" &&
  canWriteWorkspaceEntities({ organizationRole, reachesMatter });

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
  grants = readFeatureAccessGrants().grants,
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
        reachesMatter: memberReachesMatterSql(
          { organizationId: member.organizationId, userId: member.userId },
          workspaceId,
        ),
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
      reachesMatter: identity.reachesMatter,
      workspaceStatus: identity.workspaceStatus,
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
