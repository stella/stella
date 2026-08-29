import { and, desc, eq } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type { TimestampIdCursor } from "@/api/lib/db-pagination";
import { machineApiKeyOrganizationScope as organizationScope } from "@/api/lib/machine-api-key-scope";

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
 * It is defined once, in `lib/machine-api-key-scope.ts`, because membership
 * revocation applies the same scope and the two must not drift apart.
 *
 * **Why this sits in `lib` rather than beside the handlers.** Handlers are
 * barred from importing owner-level DB values; owner-level access belongs in a
 * narrow helper like this one, so the set of places that can read this table
 * unmediated by RLS stays small and reviewable. `organizationId` is a
 * `SafeId<"organization">` for the same reason: the only way to obtain one is
 * to have validated it at the authorization boundary, so an unvalidated id
 * cannot reach the tenant predicate.
 */

/** Better Auth api-key ids are text (not UUIDs); mirror `text` column bounds. */
const isMachineApiKeyIdCursorPart = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128;

/**
 * `(created_at, id)` keyset codec for the newest-first key list.
 *
 * The timestamp half is projected and compared at the column's microsecond
 * precision. `created_at` defaults to `now()`, so reading it into a JS `Date`
 * truncates it to the millisecond, and the descending `<` boundary then
 * excludes every key inside the truncated sliver: a machine credential
 * silently missing from page two is one nobody can see, and therefore one
 * nobody can revoke. Cursors issued in the older ISO form keep decoding; the
 * codec tags them millisecond-precision; the list resolves the boundary key's
 * exact timestamp under the same organization scope before comparing it.
 */
export const machineApiKeyCursor = createTimestampIdCursorCodec({
  column: apikey.createdAt,
  brandId: (id: string) => id,
  isIdPart: isMachineApiKeyIdCursorPart,
});

type MachineApiKeyCursor = TimestampIdCursor<string>;

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
  db?: Pick<typeof rootDb, "select">;
  cursor: MachineApiKeyCursor | null;
  limit: number;
  organizationId: SafeId<"organization">;
};

/**
 * A listed key plus the microsecond-precision `created_at` projection the
 * caller encodes into the next cursor. Ordering stays on the raw column.
 */
export type MachineApiKeyPageRow = MachineApiKeyRow & {
  createdAtCursor: string;
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
  db = rootDb,
}: ListOptions): Promise<MachineApiKeyPageRow[]> => {
  let exactCursor = cursor;
  if (cursor?.timestamp.precision === "milliseconds") {
    const [boundary] = await db
      .select({
        createdAtCursor:
          machineApiKeyCursor.cursorValue.as("created_at_cursor"),
      })
      .from(apikey)
      .where(and(organizationScope(organizationId), eq(apikey.id, cursor.id)))
      .limit(1);
    if (boundary === undefined) {
      return [];
    }
    exactCursor = machineApiKeyCursor.decode(
      machineApiKeyCursor.encode(boundary.createdAtCursor, cursor.id),
    );
    if (exactCursor === null) {
      return [];
    }
  }

  return await db
    .select({
      ...machineApiKeyColumns,
      createdAtCursor: machineApiKeyCursor.cursorValue.as("created_at_cursor"),
    })
    .from(apikey)
    .where(
      and(
        organizationScope(organizationId),
        exactCursor === null
          ? undefined
          : machineApiKeyCursor.keysetAfter({
              cursor: exactCursor,
              idColumn: apikey.id,
              direction: "descending",
            }),
      ),
    )
    .orderBy(desc(apikey.createdAt), desc(apikey.id))
    .limit(limit + 1);
};

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
