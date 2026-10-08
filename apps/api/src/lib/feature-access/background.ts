import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  buildFeatureAccessSnapshot,
  resolveFeatureAccess,
} from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type BackgroundFeatureAccessOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  userId: string | null;
  featureId: "signals" | "flows";
};

/** Background actors use the same live membership and enrolment as requests. */
export const isBackgroundFeatureEnabled = async ({
  tx,
  organizationId,
  userId,
  featureId,
}: BackgroundFeatureAccessOptions): Promise<boolean> => {
  if (
    !isDeploymentFeatureEnabled(
      featureId === "signals" ? "FEATURE_SIGNALS" : "FEATURE_FLOWS",
    )
  ) {
    return false;
  }
  const decision = await resolveFeatureAccess({
    tx,
    organizationId,
    userId,
    featureId,
  });
  return decision.status === "enabled";
};

type FindSignalsBackgroundActorOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  workspaceId?: SafeId<"workspace">;
};

/** A scout must represent an enrolled live member, never an arbitrary RLS actor. */
export const findSignalsBackgroundActor = async ({
  tx,
  organizationId,
  workspaceId,
}: FindSignalsBackgroundActorOptions): Promise<SafeId<"user"> | null> => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return null;
  }
  const candidates = await tx
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(
      user,
      and(
        eq(user.id, member.userId),
        eq(user.emailVerified, true),
        isNull(user.deletedAt),
      ),
    )
    .innerJoin(
      featureEnrolments,
      and(
        eq(featureEnrolments.organizationId, member.organizationId),
        eq(featureEnrolments.userId, member.userId),
        eq(featureEnrolments.featureId, "signals"),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, member.userId),
        workspaceId === undefined
          ? undefined
          : eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .leftJoin(
      workspaces,
      and(
        workspaceId === undefined
          ? eq(workspaces.id, workspaceMembers.workspaceId)
          : eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
      ),
    )
    .where(
      and(
        eq(member.organizationId, organizationId),
        workspaceId === undefined
          ? undefined
          : and(
              eq(workspaces.id, workspaceId),
              or(
                eq(workspaceMembers.workspaceId, workspaceId),
                and(
                  inArray(member.role, CLIENT_MATTER_ADMIN_ROLES),
                  isNotNull(workspaces.clientId),
                ),
              ),
            ),
      ),
    )
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  const candidate = candidates.at(0);
  if (
    !candidate ||
    !(await isBackgroundFeatureEnabled({
      tx,
      organizationId,
      userId: candidate.userId,
      featureId: "signals",
    }))
  ) {
    return null;
  }
  return brandPersistedUserId(candidate.userId);
};

type BackgroundFeaturePrincipal = {
  organizationId: SafeId<"organization">;
  userId: string;
};

type LoadBackgroundFeatureActorsOptions = {
  tx: Pick<Transaction, "select">;
  featureId: "signals" | "flows";
  principals: readonly BackgroundFeaturePrincipal[];
};

/** A bounded recovery page resolves all actors in one tenant-scoped read. */
export const loadBackgroundFeatureActors = async ({
  tx,
  featureId,
  principals,
}: LoadBackgroundFeatureActorsOptions): Promise<
  Map<SafeId<"organization">, Set<string>>
> => {
  const admitted = new Map<SafeId<"organization">, Set<string>>();
  if (
    principals.length === 0 ||
    !isDeploymentFeatureEnabled(
      featureId === "signals" ? "FEATURE_SIGNALS" : "FEATURE_FLOWS",
    )
  ) {
    return admitted;
  }
  const rows = await tx
    .select({
      organizationId: featureEnrolments.organizationId,
      userId: featureEnrolments.userId,
      featureId: featureEnrolments.featureId,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(featureEnrolments)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, featureEnrolments.organizationId),
        eq(member.userId, featureEnrolments.userId),
      ),
    )
    .innerJoin(user, and(eq(user.id, member.userId), isNull(user.deletedAt)))
    .where(
      and(
        eq(featureEnrolments.featureId, featureId),
        or(
          ...principals.map((principal) =>
            and(
              eq(featureEnrolments.organizationId, principal.organizationId),
              eq(featureEnrolments.userId, principal.userId),
            ),
          ),
        ),
      ),
    )
    .limit(principals.length);
  for (const row of rows) {
    const snapshot = buildFeatureAccessSnapshot({
      organizationId: row.organizationId,
      userId: row.userId,
      identity: { email: row.email, emailVerified: row.emailVerified },
      enrolments: [row],
    });
    if (snapshot.decisions.get(featureId)?.status !== "enabled") {
      continue;
    }
    const users = admitted.get(row.organizationId);
    if (users) {
      users.add(row.userId);
    } else {
      admitted.set(row.organizationId, new Set([row.userId]));
    }
  }
  return admitted;
};
