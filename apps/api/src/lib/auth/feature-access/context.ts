import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { featureEnrolments } from "@/api/db/schema";
import { readFeatureAccessGrants } from "@/api/env-feature-access";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type {
  FeatureAccessDecision,
  FeatureAccessSnapshot,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";
import { typedPgArray } from "@/api/lib/search/sql";

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
  grants = readFeatureAccessGrants().grants,
}: ResolveFeatureAccessSnapshotOptions): Promise<FeatureAccessSnapshot> => {
  const { candidates, enrolmentFeatureIds } = featureAccessReadPlan({
    organizationId,
    registry,
    grants,
  });
  const enrolledFeatureIds =
    enrolmentFeatureIds.length === 0
      ? sql<string[]>`'{}'::text[]`
      : sql<
          string[]
        >`coalesce((select array_agg(${featureEnrolments.featureId}) from ${featureEnrolments}
        where ${featureEnrolments.organizationId} = ${member.organizationId} and ${featureEnrolments.userId} = ${member.userId}
          and ${featureEnrolments.featureId} = ANY(${typedPgArray(enrolmentFeatureIds, "text")})), '{}')`;
  const identity =
    userId === null || candidates.length === 0
      ? undefined
      : (
          await tx
            .select({
              email: user.email,
              emailVerified: user.emailVerified,
              enrolledFeatureIds,
            })
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
  return buildFeatureAccessSnapshot({
    organizationId,
    userId,
    identity: identity ?? null,
    enrolments: (identity === undefined ? [] : identity.enrolledFeatureIds).map(
      (featureId) => ({
        featureId,
        organizationId,
        userId: userId ?? panic("Feature enrolments require a user"),
      }),
    ),
    registry,
    grants,
  });
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
