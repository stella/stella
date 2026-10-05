import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { featureEnrolments } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import type {
  FeatureAccessDecision,
  FeatureAccessSnapshot,
} from "@/api/lib/auth/feature-access/policy";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

type ResolveFeatureAccessSnapshotOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  userId: string | null;
  registry?: FeatureRegistry;
  grants?: FeatureAccessGrants;
};

export const resolveFeatureAccessSnapshot = async ({
  tx,
  organizationId,
  userId,
  registry = FEATURE_REGISTRY,
  grants = env.API_FEATURE_ACCESS_GRANTS,
}: ResolveFeatureAccessSnapshotOptions): Promise<FeatureAccessSnapshot> => {
  const featureIds = Object.keys(registry);
  const decisions = new Map<string, FeatureAccessDecision>();
  if (featureIds.length === 0) {
    return createFeatureAccessSnapshot({ organizationId, userId, decisions });
  }
  const identity =
    userId === null
      ? undefined
      : (
          await tx
            .select({ email: user.email, emailVerified: user.emailVerified })
            .from(member)
            .innerJoin(user, eq(user.id, member.userId))
            .where(
              and(
                eq(member.organizationId, organizationId),
                eq(member.userId, userId),
                isNull(user.deletedAt),
              ),
            )
            .limit(1)
        ).at(0);
  const enrolments =
    userId === null ||
    identity === undefined ||
    !Object.values(registry).some(
      (definition) => definition.enrolment === "self-serve",
    )
      ? []
      : await tx
          .select({
            featureId: featureEnrolments.featureId,
            organizationId: featureEnrolments.organizationId,
            userId: featureEnrolments.userId,
          })
          .from(featureEnrolments)
          .where(
            and(
              eq(featureEnrolments.organizationId, organizationId),
              eq(featureEnrolments.userId, userId),
            ),
          )
          .limit(featureIds.length);
  for (const featureId of featureIds) {
    const deploymentFeature = registry[featureId]?.deploymentFeature;
    decisions.set(
      featureId,
      decideFeatureAccess({
        registry,
        grants,
        featureId,
        organizationId,
        userId,
        user: identity ?? null,
        membership: identity !== undefined,
        enrolments,
        // The snapshot owns the deployment switch AND the per-caller decision.
        deploymentEnabled:
          deploymentFeature === undefined ||
          isDeploymentFeatureEnabled(deploymentFeature),
      }),
    );
  }
  return createFeatureAccessSnapshot({ organizationId, userId, decisions });
};

type ResolveFeatureAccessOptions = ResolveFeatureAccessSnapshotOptions & {
  featureId: string;
};

export const resolveFeatureAccess = async ({
  featureId,
  ...options
}: ResolveFeatureAccessOptions): Promise<FeatureAccessDecision> => {
  const snapshot = await resolveFeatureAccessSnapshot(options);
  return snapshot.decisions.get(featureId) ?? { status: "hidden" };
};

type LoadFeatureAccessSnapshotOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: string | null;
};

export const loadFeatureAccessSnapshot = async ({
  safeDb,
  organizationId,
  userId,
}: LoadFeatureAccessSnapshotOptions) => {
  if (Object.keys(FEATURE_REGISTRY).length === 0) {
    return Result.ok(
      createFeatureAccessSnapshot({
        organizationId,
        userId,
        decisions: new Map(),
      }),
    );
  }
  return await safeDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId,
        userId,
      }),
  );
};
