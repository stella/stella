import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { envFeatureAccess } from "@/api/env-feature-access";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isFeatureDeployed } from "@/api/lib/feature-access/deployment";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
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
  // The same deployment decision as the request snapshot: a feature whose
  // routes the deployment hides admits nothing through row policies.
  const candidates = Object.keys(FEATURE_REGISTRY).filter(
    (id) =>
      isFeatureDeployed(FEATURE_REGISTRY, id) &&
      [...featurePrerequisiteClosure(FEATURE_REGISTRY, id)].every(
        (required) =>
          envFeatureAccess.API_FEATURE_ACCESS_GRANTS[required]?.some(
            (grant) => grant.organizationId === organizationId,
          ) === true,
      ),
  );
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
  return candidates.filter(
    (featureId) =>
      decideFeatureAccess({
        registry: FEATURE_REGISTRY,
        grants: envFeatureAccess.API_FEATURE_ACCESS_GRANTS,
        featureId,
        organizationId,
        userId,
        user,
        membership: true,
        deploymentEnabled: isFeatureDeployed(FEATURE_REGISTRY, featureId),
      }).status === "enabled",
  );
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
