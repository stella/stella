import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  ORGANIZATION_DATA_BOX_LIMIT,
  type UpdateOrganizationDataBoxesResponse,
} from "@stll/api-contract/data-box";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { recomputeDataBoxDirections } from "@/api/lib/data-box/direction";

export const dataBoxIdSchema = t.String({
  pattern: "^[A-Za-z0-9]{7}$",
  description: "A data-box ID: seven letters or digits.",
});

type SaveOrganizationDataBoxesOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  change: (current: readonly string[]) => string[];
};

type SaveOrganizationDataBoxesResult =
  | { type: "saved"; value: UpdateOrganizationDataBoxesResponse }
  | { type: "limit_reached" }
  | { type: "conflict" };

/**
 * Applies one change to the organization's own boxes, written only over the
 * list it was computed from (a concurrent change is a conflict), then
 * re-derives the direction of its filed data-box messages in the matters the
 * transaction may reach. An unchanged list writes nothing but still
 * re-derives, so a repeat call converges.
 */
export const saveOrganizationDataBoxes = async ({
  tx,
  organizationId,
  recordAuditEvent,
  change,
}: SaveOrganizationDataBoxesOptions): Promise<SaveOrganizationDataBoxesResult> => {
  const [settings] = await tx
    .select({ dataBoxIds: organizationSettings.dataBoxIds })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const current = settings?.dataBoxIds ?? [];
  const boxIds = change(current);
  if (boxIds.length > ORGANIZATION_DATA_BOX_LIMIT) {
    return { type: "limit_reached" };
  }
  const changed =
    boxIds.length !== current.length ||
    boxIds.some((id, index) => id !== current[index]);
  if (changed) {
    const written =
      settings === undefined
        ? await tx
            .insert(organizationSettings)
            .values({
              id: createSafeId<"organizationSettings">(),
              organizationId,
              dataBoxIds: boxIds,
            })
            .onConflictDoNothing({
              target: organizationSettings.organizationId,
            })
            .returning({ id: organizationSettings.id })
        : await tx
            .update(organizationSettings)
            .set({ dataBoxIds: boxIds, updatedAt: new Date() })
            .where(
              and(
                eq(organizationSettings.organizationId, organizationId),
                sql`${organizationSettings.dataBoxIds} = ${JSON.stringify(current)}::text::jsonb`,
              ),
            )
            .returning({ id: organizationSettings.id });
    if (written.length === 0) {
      return { type: "conflict" };
    }
  }
  const recomputed = await recomputeDataBoxDirections({
    tx,
    organizationId,
    organizationBoxIds: boxIds,
  });
  if (changed || recomputed > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      changes: changed
        ? { dataBoxIds: { old: [...current], new: boxIds } }
        : null,
      metadata: { recomputedCorrespondence: recomputed },
    });
  }
  return { type: "saved", value: { boxIds, recomputed } };
};
