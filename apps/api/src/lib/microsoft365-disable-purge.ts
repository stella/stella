import { eq } from "drizzle-orm";
/**
 * Org-level kill switch for the Microsoft 365 connection.
 *
 * Disabling the org toggle must be a true revocation, not a soft hide: with
 * the tokens retained, re-enabling would silently resurrect working refresh
 * tokens. So setting `microsoft365_connection_enabled` to false also purges
 * every member's stored connection (and any pending OAuth state) in the SAME
 * transaction as the toggle write.
 *
 * We cannot revoke the grant at Microsoft, but we must not retain usable
 * tokens on our side.
 *
 * The public entry point runs on the elevated (table-owner) connection
 * deliberately: the per-user RLS on microsoft365_connections would otherwise let
 * an admin delete only their own row. This owner-level access lives in a lib
 * helper (handlers may not import the root db); every statement is filtered by
 * the server-validated organizationId, so the elevation reaches exactly this
 * org's rows.
 */

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  organizationSettings,
  microsoft365Connections,
  microsoft365OAuthState,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";

export type Microsoft365DisablePurgeResult = {
  purgedConnections: number;
  purgedPendingStates: number;
};

type PurgeOptions = {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
};

// Transaction body: force the toggle false, purge every member's tokens and
// pending OAuth state for the org, and record both the toggle change and the
// purge in the same transaction. Tx-agnostic so it can run under the elevated
// wrapper below or a test transaction.
export const purgeMicrosoft365ForOrg = async (
  tx: Transaction,
  { organizationId, recordAuditEvent }: PurgeOptions,
): Promise<Microsoft365DisablePurgeResult> => {
  await withAggregateLock({
    tx,
    aggregate: "organization",
    id: organizationId,
    mode: "update",
  });
  const previous = await tx.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: { microsoft365ConnectionEnabled: true },
  });

  await tx
    .insert(organizationSettings)
    .values({
      id: createSafeId<"organizationSettings">(),
      organizationId,
      microsoft365ConnectionEnabled: false,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { microsoft365ConnectionEnabled: false, updatedAt: new Date() },
    });

  const purgedConnections = await tx
    .delete(microsoft365Connections)
    .where(eq(microsoft365Connections.organizationId, organizationId))
    .returning({ id: microsoft365Connections.id });

  const purgedStates = await tx
    .delete(microsoft365OAuthState)
    .where(eq(microsoft365OAuthState.organizationId, organizationId))
    .returning({ state: microsoft365OAuthState.state });

  await recordAuditEvent(tx, [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      changes: {
        microsoft365ConnectionEnabled: {
          old: previous?.microsoft365ConnectionEnabled ?? false,
          new: false,
        },
      },
    },
    {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      metadata: {
        operation: "microsoft365_oauth_disconnect",
        scope: "org_disable_purge",
        purgedConnections: purgedConnections.length,
        purgedPendingStates: purgedStates.length,
      },
    },
  ]);

  return {
    purgedConnections: purgedConnections.length,
    purgedPendingStates: purgedStates.length,
  };
};

export const disableAndPurgeMicrosoft365ForOrg = async (
  options: PurgeOptions,
): Promise<Microsoft365DisablePurgeResult> =>
  await withAggregateTransaction(
    rootDb,
    async (tx) => await purgeMicrosoft365ForOrg(tx, options),
  );
