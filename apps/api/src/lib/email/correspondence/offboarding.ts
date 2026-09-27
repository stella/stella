import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  correspondence,
  CORRESPONDENCE_ERASURE_SETTING,
  CORRESPONDENCE_OFFBOARDING_SETTING,
  correspondenceAllowedSenders,
  correspondenceFilers,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const OFFBOARDING_ASSIGNMENT_BATCH_SIZE = 500;
const ACTOR_ERASURE_BATCH_SIZE = 500;

type EraseCorrespondenceActorDisplaysOptions = {
  tx: Transaction;
  userId: SafeId<"user">;
};

export const eraseCorrespondenceActorDisplays = async ({
  tx,
  userId,
}: EraseCorrespondenceActorDisplaysOptions) => {
  await tx.execute(sql`SELECT
    set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, ${userId}, true),
    set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, '', true)
  `);
  let afterFilerId: SafeId<"correspondenceFiler"> | undefined;
  while (true) {
    const rows = await tx
      .select({ id: correspondenceFilers.id })
      .from(correspondenceFilers)
      .where(
        and(
          eq(correspondenceFilers.filedByUserId, userId),
          afterFilerId === undefined
            ? undefined
            : gt(correspondenceFilers.id, afterFilerId),
        ),
      )
      .orderBy(asc(correspondenceFilers.id))
      .limit(ACTOR_ERASURE_BATCH_SIZE)
      .for("update");
    const last = rows.at(-1);
    if (last === undefined) {
      break;
    }

    const recordIds = rows.map(({ id }) => id);
    await tx.execute(
      sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, ${`{${recordIds.join(",")}}`}, true)`,
    );
    const erased = await tx
      .update(correspondenceFilers)
      .set({ filedByDisplay: { status: "deleted" } })
      .where(
        and(
          eq(correspondenceFilers.filedByUserId, userId),
          inArray(correspondenceFilers.id, recordIds),
        ),
      )
      .returning({ id: correspondenceFilers.id });
    if (erased.length !== recordIds.length) {
      panic("Locked correspondence filer snapshots were not erased");
    }
    afterFilerId = last.id;
  }

  let afterSenderId: SafeId<"correspondenceAllowedSender"> | undefined;
  while (true) {
    const rows = await tx
      .select({ id: correspondenceAllowedSenders.id })
      .from(correspondenceAllowedSenders)
      .where(
        and(
          eq(correspondenceAllowedSenders.approvedBy, userId),
          afterSenderId === undefined
            ? undefined
            : gt(correspondenceAllowedSenders.id, afterSenderId),
        ),
      )
      .orderBy(asc(correspondenceAllowedSenders.id))
      .limit(ACTOR_ERASURE_BATCH_SIZE)
      .for("update");
    const last = rows.at(-1);
    if (last === undefined) {
      break;
    }

    const recordIds = rows.map(({ id }) => id);
    await tx.execute(
      sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, ${`{${recordIds.join(",")}}`}, true)`,
    );
    const erased = await tx
      .update(correspondenceAllowedSenders)
      .set({ approvedByDisplay: { status: "deleted" } })
      .where(
        and(
          eq(correspondenceAllowedSenders.approvedBy, userId),
          inArray(correspondenceAllowedSenders.id, recordIds),
        ),
      )
      .returning({ id: correspondenceAllowedSenders.id });
    if (erased.length !== recordIds.length) {
      panic("Locked correspondence approver snapshots were not erased");
    }
    afterSenderId = last.id;
  }
  await tx.execute(sql`SELECT
    set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, '', true),
    set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, '', true)
  `);
};

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
  let clearedCount = 0;
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
    clearedCount += cleared.length;
  }
  await tx.execute(sql`SELECT
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.userId}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.organizationId}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.scope}, '', true),
    set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.recordIds}, '', true)
  `);
  return clearedCount;
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
  const clearedCount = await clearCorrespondenceAssignmentsForOffboarding({
    tx,
    userId,
    scope: { type: "organization", organizationId },
  });
  if (clearedCount === 0) {
    return;
  }

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
