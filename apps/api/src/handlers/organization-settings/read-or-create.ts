import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type ReadOrCreateOrganizationSettingsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
};

// Defaults need a persisted version before an editor can replace them. The
// unique organization key makes simultaneous first reads converge on one row.
export const readOrCreateOrganizationSettings = async ({
  tx,
  organizationId,
  recordAuditEvent,
}: ReadOrCreateOrganizationSettingsOptions) => {
  const existing = await tx.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
  });
  if (existing) {
    return existing;
  }

  const created = (
    await tx
      .insert(organizationSettings)
      .values({ id: createSafeId<"organizationSettings">(), organizationId })
      .onConflictDoNothing({ target: organizationSettings.organizationId })
      .returning()
  ).at(0);
  if (created) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
    });
    return created;
  }

  return (
    (await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
    })) ?? panic("Organization settings initialization lost its row")
  );
};
