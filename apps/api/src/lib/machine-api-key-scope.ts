import { panic } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  API_KEY_KIND,
  MACHINE_API_KEY_CONFIG_ID,
} from "@/api/lib/machine-api-key-config";
/**
 * The one definition of "this organization's machine keys".
 *
 * It lives in its own leaf module rather than beside the read queries because
 * the membership-revocation path (`lib/auth-artifacts.ts`) needs the identical
 * predicate and must not pull in the owner-level `rootDb` connection that
 * `machine-api-key-queries.ts` opens. Reads and revocation sharing one
 * expression is the point: a tenant filter that is written twice is a tenant
 * filter that eventually disagrees with itself, and the half that drifts is
 * silently either a leak or a key that outlives its membership.
 */
import type { ApiKeyKind } from "@/api/lib/machine-api-key-config";

/** The owning organization id, read out of the plugin's JSON metadata column. */
const metadataOrganizationId = sql`(${apikey.metadata}::jsonb ->> 'organizationId')`;

/**
 * Rows belonging to one organization's machine-key configuration. Both halves
 * matter: `configId` keeps keys minted under some other configuration out, and
 * the metadata predicate is the tenant scope.
 *
 * `organizationId` is a `SafeId<"organization">` because the only way to obtain
 * one is to have validated it at an authorization boundary, so an unvalidated
 * id cannot reach the tenant predicate.
 */
export const machineApiKeyOrganizationScope = (
  organizationId: SafeId<"organization">,
) =>
  and(
    eq(apikey.configId, MACHINE_API_KEY_CONFIG_ID),
    sql`${metadataOrganizationId} = ${organizationId}`,
  );

/** Legacy persisted machine keys omit kind; personal keys always name it. */
export const apiKeyKindScope = (kind: ApiKeyKind) => {
  const metadataKind = sql`(${apikey.metadata}::jsonb ->> 'kind')`;
  switch (kind) {
    case API_KEY_KIND.machine:
      return or(isNull(metadataKind), sql`${metadataKind} = ${kind}`);
    case API_KEY_KIND.personal:
      return and(
        sql`${apikey.metadata} IS NOT NULL`,
        sql`${metadataKind} = 'personal'`,
      );
    default:
      kind satisfies never;
      return panic(`Unhandled API key kind: ${String(kind)}`);
  }
};
