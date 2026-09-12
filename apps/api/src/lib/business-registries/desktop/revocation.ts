import { and, eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { apikey } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/lib/business-registries/desktop/config";

type RevokeDesktopRegistryCredentialOptions = {
  keyId: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  db?: Pick<typeof rootDb, "transaction">;
};

// The auth-owned key table denies the scoped Stella role. Keep this owner
// transaction bounded to the authenticated credential and commit its audit
// event together with the conditional revocation.
export const revokeDesktopRegistryCredential = async ({
  keyId,
  organizationId,
  userId,
  recordAuditEvent,
  db = rootDb,
}: RevokeDesktopRegistryCredentialOptions) =>
  await db.transaction(async (tx) => {
    const revoked = await tx
      .update(apikey)
      .set({
        enabled: false,
        updatedAt: new Date(Temporal.Now.instant().epochMilliseconds),
      })
      .where(
        and(
          eq(apikey.id, keyId),
          eq(apikey.configId, DESKTOP_REGISTRY_KEY_CONFIG),
          eq(apikey.referenceId, userId),
          eq(apikey.enabled, true),
          sql`${apikey.metadata}::text::jsonb ->> 'organizationId' = ${organizationId}`,
          sql`${apikey.metadata}::text::jsonb ->> 'purpose' = ${DESKTOP_REGISTRY_KEY_CONFIG}`,
        ),
      )
      .returning({ id: apikey.id });
    if (revoked.length === 0) {
      return;
    }
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
      resourceId: keyId,
      metadata: { purpose: DESKTOP_REGISTRY_KEY_CONFIG, enabled: false },
    });
  });
