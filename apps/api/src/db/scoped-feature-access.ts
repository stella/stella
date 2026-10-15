import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";
import { isRecord } from "@/api/lib/type-guards";

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
  // Request scopes reuse their authenticated snapshot. Snapshot-less scopes
  // retain invitation-only admission, including under restricted owner roles
  // and migration schemas that cannot read feature enrolments.
  const { candidates } = featureAccessReadPlan({
    organizationId,
    enrolmentSource: "none",
  });
  if (candidates.length === 0) {
    return [];
  }
  const identity = executedRows(
    await tx.execute(sql`
    SELECT u.email, u.email_verified AS "emailVerified"
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
    typeof identity["emailVerified"] !== "boolean"
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
    enrolments: [],
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
