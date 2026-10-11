import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
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
  const identity = executedRows(
    await tx.execute(sql`
    SELECT u.email, u.email_verified AS "emailVerified",
      coalesce((SELECT array_agg(e.feature_id) FROM public.feature_enrolments e
        WHERE e.organization_id = m.organization_id AND e.user_id = m.user_id), '{}') AS "enrolledFeatureIds"
    FROM public.member m INNER JOIN public."user" u ON u.id = m.user_id
    WHERE m.organization_id = ${organizationId} AND m.user_id = ${userId}
      AND u.deleted_at IS NULL
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
