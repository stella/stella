import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";

/**
 * Organization-scoped reads of the machine-key table.
 *
 * **Why this bypasses the plugin's own read endpoints.** `getApiKey` and
 * `listApiKeys` resolve the caller from the session and then hard-scope to
 * `referenceId === session.user.id`. That makes key management *caller*-owned:
 * an org admin could not list, rotate, or revoke a key minted by a colleague,
 * so a departing employee's (or a leaked) credential would have no revocation
 * path at all. Lifecycle here is authorized on the `organizationSettings`
 * permission plus the caller's active organization, which is strictly broader
 * than "keys I personally minted" and is the boundary the product actually
 * needs, so the plugin's narrower read is replaced rather than layered on.
 *
 * **The filter is the tenant boundary.** The `apikey` table denies the scoped
 * `stella` role outright (`denyStellaAccessPolicies`), so these queries run on
 * `rootDb`, the owner connection, where RLS does not apply. Nothing below the
 * `WHERE` clause separates one organization's credentials from another's —
 * which is why the organization predicate is built into every query in this
 * module and is never applied after the fact in JS. A post-filter would mean
 * the database had already handed us another tenant's rows.
 *
 * The predicate is indexed (`apikey_metadata_organization_id_idx`,
 * `apikey_org_keyset_idx`); see `20260720140000_machine_api_keys_org_index`.
 *
 * **Why this sits in `lib` rather than beside the handlers.** Handlers are
 * barred from importing owner-level DB values; owner-level access belongs in a
 * narrow helper like this one, so the set of places that can read this table
 * unmediated by RLS stays small and reviewable. `organizationId` is a
 * `SafeId<"organization">` for the same reason: the only way to obtain one is
 * to have validated it at the authorization boundary, so an unvalidated id
 * cannot reach the tenant predicate.
 */

/** The owning organization id, read out of the plugin's JSON metadata column. */
const metadataOrganizationId = sql`(${apikey.metadata}::jsonb ->> 'organizationId')`;

/**
 * Rows belonging to one organization's machine-key configuration. Both halves
 * matter: `configId` keeps keys minted under some other configuration out, and
 * the metadata predicate is the tenant scope.
 */
const organizationScope = (organizationId: SafeId<"organization">) =>
  and(
    eq(apikey.configId, MACHINE_API_KEY_CONFIG_ID),
    sql`${metadataOrganizationId} = ${organizationId}`,
  );

const machineApiKeyColumns = {
  createdAt: apikey.createdAt,
  enabled: apikey.enabled,
  expiresAt: apikey.expiresAt,
  id: apikey.id,
  lastRequest: apikey.lastRequest,
  metadata: apikey.metadata,
  name: apikey.name,
  permissions: apikey.permissions,
  /**
   * The key's owner. Needed because the plugin's `updateApiKey` still checks
   * `referenceId === body.userId` when called server-side, so revoking another
   * member's key means telling it who that member is.
   */
  referenceId: apikey.referenceId,
  start: apikey.start,
} as const;

export type MachineApiKeyRow = {
  createdAt: Date;
  enabled: boolean;
  expiresAt: Date | null;
  id: string;
  lastRequest: Date | null;
  metadata: string | null;
  name: string | null;
  permissions: string | null;
  referenceId: string;
  start: string | null;
};

type ListOptions = {
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
  organizationId: SafeId<"organization">;
};

/**
 * One page of an organization's machine keys, newest first.
 *
 * Keyset rather than offset: the boundary comparison runs in the database on
 * `(created_at, id)` so a key minted mid-pagination cannot shift rows across
 * page edges. `limit + 1` rows are fetched so the caller can tell whether a
 * further page exists without a second count query.
 */
export const listOrganizationMachineApiKeys = async ({
  cursor,
  limit,
  organizationId,
}: ListOptions): Promise<MachineApiKeyRow[]> =>
  await rootDb
    .select(machineApiKeyColumns)
    .from(apikey)
    .where(
      cursor === null
        ? organizationScope(organizationId)
        : and(
            organizationScope(organizationId),
            or(
              lt(apikey.createdAt, cursor.createdAt),
              and(
                eq(apikey.createdAt, cursor.createdAt),
                lt(apikey.id, cursor.id),
              ),
            ),
          ),
    )
    .orderBy(desc(apikey.createdAt), desc(apikey.id))
    .limit(limit + 1);

/**
 * A single machine key, scoped to the organization in the same query.
 *
 * Returning `null` for "not in this organization" is deliberate: callers turn
 * it into a 404, so probing ids cannot distinguish a key that belongs to
 * another organization from one that does not exist.
 */
export const findOrganizationMachineApiKey = async ({
  keyId,
  organizationId,
}: {
  keyId: string;
  organizationId: SafeId<"organization">;
}): Promise<MachineApiKeyRow | null> =>
  await rootDb
    .select(machineApiKeyColumns)
    .from(apikey)
    .where(and(organizationScope(organizationId), eq(apikey.id, keyId)))
    .limit(1)
    .then((rows) => rows.at(0) ?? null);
