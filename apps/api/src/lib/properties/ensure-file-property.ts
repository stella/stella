import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { properties } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { lockWorkspacePropertyWrites } from "@/api/lib/properties/property-lock";

type EnsureFilePropertyOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** Localized name for a property created here. */
  name: string;
  recordAuditEvent: AuditRecorder;
};

/**
 * Gives a matter its file property when it has none, with the same shape a
 * new matter gets, under the workspace's property-write lock so concurrent
 * callers add exactly one. Returns whether a property was created.
 */
export const ensureFileProperty = async ({
  tx,
  workspaceId,
  name,
  recordAuditEvent,
}: EnsureFilePropertyOptions): Promise<boolean> => {
  await lockWorkspacePropertyWrites(tx, workspaceId);
  const existing = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        sql`${properties.content}->>'type' = 'file'`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return false;
  }
  const [inserted] = await tx
    .insert(properties)
    .values({
      workspaceId,
      name,
      content: { type: "file", version: 1 },
      tool: { version: 1, type: "manual-input" },
      // The file column is user-managed (uploads), so it starts fresh.
      status: "fresh",
      system: true,
      kinds: ["document"],
    })
    .returning({ id: properties.id });
  if (inserted === undefined) {
    return false;
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
    resourceId: inserted.id,
    changes: {
      created: {
        old: null,
        new: { name, contentType: "file", toolType: "manual-input" },
      },
    },
  });
  return true;
};
