import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  correspondence,
  CORRESPONDENCE_OFFBOARDING_SETTING,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const OFFBOARDING_ASSIGNMENT_BATCH_SIZE = 500;

type ClearCorrespondenceAssignmentsOptions = {
  tx: Transaction;
  userId: SafeId<"user">;
  scope:
    | { type: "account" }
    | { type: "organization"; organizationId: SafeId<"organization"> };
};

export const clearCorrespondenceAssignmentsForOffboarding = async ({
  tx,
  userId,
  scope,
}: ClearCorrespondenceAssignmentsOptions) => {
  const organizationId =
    scope.type === "organization" ? scope.organizationId : "";
  await tx.execute(sql`SELECT
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.userId}, ${userId}, true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.organizationId}, ${organizationId}, true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.scope}, ${scope.type}, true)
  `);
  const assignedScope = and(
    scope.type === "organization"
      ? eq(correspondence.organizationId, scope.organizationId)
      : undefined,
    eq(correspondence.assigneeId, userId),
  );
  while (true) {
    const records = await tx
      .select({ id: correspondence.id })
      .from(correspondence)
      .where(assignedScope)
      .orderBy(asc(correspondence.organizationId), asc(correspondence.id))
      .limit(OFFBOARDING_ASSIGNMENT_BATCH_SIZE)
      .for("update");
    if (records.length === 0) {
      break;
    }

    const recordIds = records.map(({ id }) => id);
    await tx.execute(
      sql`SELECT set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.recordIds}, ${`{${recordIds.join(",")}}`}, true)`,
    );
    const cleared = await tx
      .update(correspondence)
      .set({ assigneeId: null, updatedAt: new Date() })
      .where(and(assignedScope, inArray(correspondence.id, recordIds)))
      .returning({ id: correspondence.id });
    if (cleared.length !== recordIds.length) {
      panic("Locked correspondence assignments were not cleared");
    }
  }
  await tx.execute(sql`SELECT
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.userId}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.organizationId}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.scope}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.recordIds}, '', true)
  `);
};

type ClearOrganizationCorrespondenceAssignmentsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const clearOrganizationCorrespondenceAssignments = async ({
  tx,
  organizationId,
  userId,
}: ClearOrganizationCorrespondenceAssignmentsOptions) => {
  await clearCorrespondenceAssignmentsForOffboarding({
    tx,
    userId,
    scope: { type: "organization", organizationId },
  });

  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: {
        type: "service",
        id: "organization-member-removal",
        name: "Organization member removal",
      },
      trigger: { type: "system", source: "organization_member_removal" },
    },
    organizationId,
    userId,
    workspaceId: null,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    changes: { correspondenceAssigneeId: { old: userId, new: null } },
    metadata: {
      cause: "organization_member_removed",
      correspondenceAssignmentDisposition: "cleared",
    },
  });
};
