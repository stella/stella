import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  ORGANIZATION_DATA_BOX_LIMIT,
  type UpdateOrganizationDataBoxesResponse,
  type DataBoxDirectionBasis,
} from "@stll/api-contract/data-box";

import type { Transaction } from "@/api/db/root";
import { correspondence, organizationSettings } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

export const dataBoxIdSchema = t.String({
  pattern: "^[A-Za-z0-9]{7}$",
  description: "A data-box ID: seven letters or digits.",
});

const EMPTY_BOX_IDS: readonly string[] = [];

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
 * list it was computed from, serialized with filing even for a no-op, then
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
  await withAggregateLock({
    tx,
    aggregate: "dataBoxDirection",
    id: { organizationId },
  });
  const [settings] = await tx
    .select({ dataBoxIds: organizationSettings.dataBoxIds })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const current = settings === undefined ? EMPTY_BOX_IDS : settings.dataBoxIds;
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
  const boxes = sql`${JSON.stringify(boxIds)}::text::jsonb`;
  const fromOrganization = sql`jsonb_exists(${boxes}, ${correspondence.dataBox} -> 'sender' ->> 'boxId')`;
  const toOrganization = sql`jsonb_exists(${boxes}, ${correspondence.dataBox} -> 'recipient' ->> 'boxId')`;
  const basis = sql<DataBoxDirectionBasis>`(CASE
    WHEN ${fromOrganization} AND NOT ${toOrganization} THEN 'organization_sender'
    WHEN ${toOrganization} AND NOT ${fromOrganization} THEN 'organization_recipient'
    ELSE 'unknown'
  END)`;
  const updated = await tx
    .update(correspondence)
    .set({
      direction: sql`(CASE WHEN ${basis} = 'organization_sender' THEN 'out' ELSE 'in' END)`,
      dataBox: sql`jsonb_set(${correspondence.dataBox}, '{directionBasis}', to_jsonb(${basis}))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(correspondence.organizationId, organizationId),
        eq(correspondence.channel, "data_box"),
        sql`${correspondence.dataBox} ->> 'directionBasis' IS DISTINCT FROM ${basis}`,
      ),
    )
    .returning({ id: correspondence.id });
  const recomputed = updated.length;
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
