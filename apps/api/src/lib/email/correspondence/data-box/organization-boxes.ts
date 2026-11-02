import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

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
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const dataBoxIdSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9]{7}$/u),
  v.description("A data-box ID: seven letters or digits."),
);

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
  | { type: "conflict" }
  | { type: "busy" };

/** Bounded organization settings read, shared by every wire projection. */
export const readOrganizationDataBoxIds = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  const [settings] = await tx
    .select({ dataBoxIds: organizationSettings.dataBoxIds })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return settings?.dataBoxIds ?? EMPTY_BOX_IDS;
};

/** Mutate the bounded inventory; filed envelopes remain immutable. */
export const saveOrganizationDataBoxes = async ({
  tx,
  organizationId,
  recordAuditEvent,
  change,
}: SaveOrganizationDataBoxesOptions): Promise<SaveOrganizationDataBoxesResult> => {
  const lock = await withAggregateLock({
    tx,
    aggregate: "organizationDataBoxes",
    id: { organizationId },
  });
  switch (lock.status) {
    case "locked":
      break;
    case "busy":
      return { type: "busy" };
    case "missing":
      return panic("An advisory organization lock has no row to miss");
    default:
      lock satisfies never;
      return panic("Unhandled organization data box lock");
  }
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
  if (changed) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      changes: { dataBoxIds: { old: [...current], new: boxIds } },
    });
  }
  return { type: "saved", value: { boxIds } };
};

const DATA_BOX_RETRY_AFTER_MS = 1000;

/** One answer per inventory change outcome, shared by add and remove. */
export const organizationDataBoxesChangeResult = (
  saved: SaveOrganizationDataBoxesResult,
): Result<UpdateOrganizationDataBoxesResponse, HandlerError> => {
  switch (saved.type) {
    case "saved":
      return Result.ok(saved.value);
    case "limit_reached":
      return Result.err(
        new HandlerError({
          status: 400,
          message: `An organization lists at most ${ORGANIZATION_DATA_BOX_LIMIT} data boxes; remove one first`,
        }),
      );
    case "conflict":
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "The organization's data boxes changed concurrently; read them again and retry",
        }),
      );
    case "busy":
      return Result.err(
        new HandlerError({
          status: 503,
          code: "service_unavailable",
          message:
            "The organization's data boxes are being changed; retry shortly",
          retryable: true,
          retryAfterMs: DATA_BOX_RETRY_AFTER_MS,
        }),
      );
    default:
      saved satisfies never;
      return panic("Unhandled data box change");
  }
};
