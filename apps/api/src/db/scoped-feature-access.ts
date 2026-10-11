import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { member, user as authUser } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { featureEnrolments } from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";
import { typedPgArray } from "@/api/lib/search/sql";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

type ScopedFeatureAccessOptions = {
  tx: { execute: (query: SQLWrapper | string) => PromiseLike<unknown> };
  organizationId: string;
  userId: string | null;
};

export const resolveScopedFeatureIds = async ({
  tx,
  organizationId,
  userId,
}: ScopedFeatureAccessOptions): Promise<string[]> => {
  if (userId === null) {
    return [];
  }
  const { candidates, enrolmentFeatureIds } = featureAccessReadPlan({
    organizationId,
  });
  if (candidates.length === 0) {
    return [];
  }
  const enrolments =
    enrolmentFeatureIds.length === 0
      ? sql`'{}'::text[]`
      : sql`coalesce((SELECT array_agg(${featureEnrolments.featureId}) FROM ${featureEnrolments}
        WHERE ${featureEnrolments.organizationId} = ${member.organizationId} AND ${featureEnrolments.userId} = ${member.userId}
          AND ${featureEnrolments.featureId} = ANY(${typedPgArray(enrolmentFeatureIds, "text")})), '{}')`;
  const identity = executedRows(
    await tx.execute(sql`
    SELECT ${authUser.email} AS email, ${authUser.emailVerified} AS "emailVerified",
      ${enrolments} AS "enrolledFeatureIds"
    FROM ${member} INNER JOIN ${authUser} ON ${authUser.id} = ${member.userId}
    WHERE ${member.organizationId} = ${organizationId} AND ${member.userId} = ${userId}
      AND ${authUser.deletedAt} IS NULL
    LIMIT 1
  `),
  ).at(0);
  if (identity === undefined) {
    return [];
  }
  if (
    !isRecord(identity) ||
    typeof identity["email"] !== "string" ||
    typeof identity["emailVerified"] !== "boolean" ||
    !isUnknownArray(identity["enrolledFeatureIds"]) ||
    !identity["enrolledFeatureIds"].every((id) => typeof id === "string")
  ) {
    return panic("Feature access requires a verified identity row");
  }
  const user = {
    email: identity["email"],
    emailVerified: identity["emailVerified"],
  };
  const snapshot = buildFeatureAccessSnapshot({
    organizationId,
    userId,
    identity: user,
    enrolments: identity["enrolledFeatureIds"].map((featureId) => ({
      featureId,
      organizationId,
      userId,
    })),
  });
  return [...snapshot.decisions]
    .filter(([, decision]) => decision.status === "enabled")
    .map(([featureId]) => featureId);
};

/** Admission reads the feature decision installed by the authenticated scope. */
export const isScopedFeatureEnabled = async (
  tx: Pick<Transaction, "execute">,
  featureId: string,
): Promise<boolean> => {
  const row = executedRows(
    await tx.execute(sql`SELECT
    coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? ${featureId} AS enabled
  `),
  ).at(0);
  if (!isRecord(row) || typeof row["enabled"] !== "boolean") {
    return panic("Feature scope requires a boolean decision");
  }
  return row["enabled"];
};
