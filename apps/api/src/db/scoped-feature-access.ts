import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { env } from "@/api/env";
import { decideFeatureAccess } from "@/api/lib/auth/feature-access/policy";
import { executedRows } from "@/api/lib/db/executed-rows";
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
  const candidates = Object.keys(FEATURE_REGISTRY).filter((id) =>
    [...featurePrerequisiteClosure(FEATURE_REGISTRY, id)].every(
      (required) =>
        env.API_FEATURE_ACCESS_GRANTS[required]?.some(
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
        grants: env.API_FEATURE_ACCESS_GRANTS,
        featureId,
        organizationId,
        userId,
        user,
        membership: true,
      }).status === "enabled",
  );
};
