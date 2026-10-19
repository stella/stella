import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { featureEnrolments } from "@/api/db/schema";
import { envFeatureAccess } from "@/api/env-feature-access";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";
import { typedPgArray } from "@/api/lib/search/sql";

export type ResolveFeatureAccessSnapshotOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  userId: string | null;
  registry?: FeatureRegistry;
  grants?: FeatureAccessGrants;
};

/**
 * Read one member's live feature access (identity plus enrolments) in the
 * caller's transaction. Lives outside the authentication layer so database
 * scopes can resolve it without importing authentication modules.
 */
export const resolveFeatureAccessSnapshot = async ({
  tx,
  organizationId,
  userId,
  registry = FEATURE_REGISTRY,
  grants = envFeatureAccess.API_FEATURE_ACCESS_GRANTS,
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
