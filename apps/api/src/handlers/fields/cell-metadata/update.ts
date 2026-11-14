import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { REVIEW_FLAGS, REVIEW_FLAGS_MAX_ITEMS } from "@stll/api-contract";
import type { ReviewFlag } from "@stll/api-contract";
import { CELL_OVERRIDE_ABSENT_CODE } from "@stll/api-contract/property-policy";

import type { Transaction } from "@/api/db/root";
import { cellMetadata, entities, properties } from "@/api/db/schema";
import { cellOverrideReasonSchema } from "@/api/db/schema-validators";
import type {
  CellMetadata,
  CellOverride,
  EntityKind,
} from "@/api/db/schema-validators";
import { fieldRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  carriedCellMetadata,
  hasCarriedCellMetadata,
} from "@/api/lib/fields/cell-override";

// The wire vocabulary is the column's vocabulary: a flag the cell control
// cannot render is one this endpoint refuses rather than stores.
const manualFlagsSchema = v.pipe(
  v.array(v.picklist([...REVIEW_FLAGS])),
  v.maxLength(REVIEW_FLAGS_MAX_ITEMS),
);

const config = {
  contract: "patch",
  description:
    "Set the manual flags and lock state of one cell, meaning one document's " +
    "value for one property. manualFlags is merged against baseManualFlags " +
    "rather than overwritten, so flags added or removed by someone else " +
    "since you read the cell survive; when no flags remain and the cell is " +
    "not locked, the metadata row is deleted. overrideReason sets or clears " +
    "why a person replaced the value a run produced; it is refused on a " +
    "cell that holds no such replacement. Use fields.upsert to " +
    "change the cell's value itself, and fields.column-flag.update to flag a " +
    "whole column at once.",
  permissions: {
    entity: ["update"],
  },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: fieldRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: v.object({
    propertyId: resourceIdSchema("property"),
    entityId: resourceIdSchema("entity"),
    baseManualFlags: v.exactOptional(manualFlagsSchema),
    manualFlags: manualFlagsSchema,
    locked: v.exactOptional(v.boolean()),
    overrideReason: v.exactOptional(v.nullable(cellOverrideReasonSchema)),
  }),
} satisfies WorkspaceHandlerConfig;

type UpdateCellMetadataResult =
  | { status: "ok" }
  | { status: "no-override" }
  | { status: "entity-not-found" }
  | { status: "entity-read-only" }
  | { status: "property-not-found" };

const normalizeManualFlags = (flags: readonly ReviewFlag[]): ReviewFlag[] =>
  [...new Set(flags)].toSorted();

const mergeManualFlags = ({
  baseManualFlags,
  currentManualFlags,
  requestedManualFlags,
}: {
  baseManualFlags: readonly ReviewFlag[];
  currentManualFlags: readonly ReviewFlag[];
  requestedManualFlags: readonly ReviewFlag[];
}) => {
  const requestedFlagSet = new Set(requestedManualFlags);
  const baseFlagSet = new Set(baseManualFlags);
  const removedFlagSet = new Set(
    baseManualFlags.filter((flag) => !requestedFlagSet.has(flag)),
  );
  const addedFlags = requestedManualFlags.filter(
    (flag) => !baseFlagSet.has(flag),
  );

  return normalizeManualFlags([
    ...currentManualFlags.filter((flag) => !removedFlagSet.has(flag)),
    ...addedFlags,
  ]);
};

type ResolveLockProvenanceArgs = {
  nextLocked: boolean;
  wasLocked: boolean;
  existingMetadata: CellMetadata | undefined;
  userId: string;
  addedAt: string;
};

const resolveLockProvenance = ({
  nextLocked,
  wasLocked,
  existingMetadata,
  userId,
  addedAt,
}: ResolveLockProvenanceArgs): CellMetadata["lockProvenance"] => {
  if (!nextLocked) {
    return undefined;
  }
  if (wasLocked) {
    return existingMetadata?.lockProvenance;
  }
  return {
    lockedBy: userId,
    lockedAt: addedAt,
    reason: "explicit",
  };
};

/**
 * What the rebuilt metadata carries over, with the override's reason replaced
 * when one was sent; null when a reason was sent for a cell with no override.
 */
const carriedWithReason = ({
  existing,
  overrideReason,
}: {
  existing: CellMetadata | undefined;
  overrideReason: string | null | undefined;
}): Pick<CellMetadata, "override"> | null => {
  if (overrideReason === undefined) {
    return carriedCellMetadata(existing);
  }
  const existingOverride = existing?.override;
  if (existingOverride === undefined) {
    return null;
  }
  const override: CellOverride = {
    machine: existingOverride.machine,
    editedBy: existingOverride.editedBy,
    editedAt: existingOverride.editedAt,
    reason: overrideReason,
  };
  return { override };
};

type UpsertCellMetadataArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  metadata: CellMetadata;
  userId: string;
  recordAuditEvent: AuditRecorder;
  changes: FieldDiffs;
  entity: { id: SafeId<"entity">; kind: EntityKind };
};

/** Writes the cell's metadata and records the FIELD event describing it. */
const upsertCellMetadata = async ({
  tx,
  workspaceId,
  entityVersionId,
  propertyId,
  metadata,
  userId,
  recordAuditEvent,
  changes,
  entity,
}: UpsertCellMetadataArgs) => {
  await tx
    .insert(cellMetadata)
    .values({
      workspaceId,
      entityVersionId,
      propertyId,
      metadata,
      createdBy: userId,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
      set: {
        metadata,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.FIELD,
    resourceId: `${entityVersionId}:${propertyId}`,
    changes,
    metadata: {
      entityId: entity.id,
      entityVersionId,
      kind: entity.kind,
      propertyId,
    },
  });
};

const cellOverrideAbsentRefusal = () =>
  new HandlerError({
    status: 409,
    code: CELL_OVERRIDE_ABSENT_CODE,
    retryable: false,
    message: "The cell holds no replaced machine value to explain",
    hint: "Read the cell again: a run settled it, or nobody replaced its value.",
  });

const updateCellMetadata = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    const txResult = yield* Result.await(
      safeDb(async (tx): Promise<UpdateCellMetadataResult> => {
        const entityRows = await tx
          .select({
            id: entities.id,
            currentVersionId: entities.currentVersionId,
            kind: entities.kind,
            readOnly: entities.readOnly,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const entity = entityRows.at(0);

        if (!entity) {
          return { status: "entity-not-found" };
        }

        if (entity.readOnly) {
          return { status: "entity-read-only" };
        }

        if (!entity.currentVersionId) {
          panic("Entity has no current version");
        }

        const propertyRows = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(
            and(
              eq(properties.id, body.propertyId),
              eq(properties.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        const property = propertyRows.at(0);

        if (!property) {
          return { status: "property-not-found" };
        }

        const entityVersionId = entity.currentVersionId;
        await acquireCellLock({
          tx,
          entityVersionId,
          propertyId: property.id,
        });

        const existingMetadataRows = await tx
          .select({ metadata: cellMetadata.metadata })
          .from(cellMetadata)
          .where(
            and(
              eq(cellMetadata.entityVersionId, entityVersionId),
              eq(cellMetadata.propertyId, property.id),
            ),
          )
          .limit(1)
          .for("update");
        const existingMetadata = existingMetadataRows.at(0)?.metadata;
        const currentManualFlags = normalizeManualFlags(
          arrayOrEmpty(existingMetadata?.manualFlags),
        );
        const requestedManualFlags = normalizeManualFlags(body.manualFlags);
        const baseManualFlags =
          body.baseManualFlags === undefined
            ? currentManualFlags
            : normalizeManualFlags(body.baseManualFlags);
        const manualFlags = mergeManualFlags({
          baseManualFlags,
          currentManualFlags,
          requestedManualFlags,
        });

        const wasLocked = existingMetadata?.locked === true;
        const nextLocked = body.locked ?? wasLocked;
        const changes: FieldDiffs = {
          manualFlags: { old: currentManualFlags, new: manualFlags },
        };
        if (wasLocked !== nextLocked) {
          changes["locked"] = { old: wasLocked, new: nextLocked };
        }

        const carried = carriedWithReason({
          existing: existingMetadata,
          overrideReason: body.overrideReason,
        });
        if (carried === null) {
          return { status: "no-override" };
        }
        if (body.overrideReason !== undefined) {
          changes["overrideReason"] = {
            old: existingMetadata?.override?.reason ?? null,
            new: body.overrideReason,
          };
        }

        if (
          manualFlags.length === 0 &&
          !nextLocked &&
          !hasCarriedCellMetadata(existingMetadata)
        ) {
          await tx
            .delete(cellMetadata)
            .where(
              and(
                eq(cellMetadata.entityVersionId, entityVersionId),
                eq(cellMetadata.propertyId, property.id),
              ),
            );
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FIELD,
            resourceId: `${entityVersionId}:${property.id}`,
            changes,
            metadata: {
              entityId: body.entityId,
              entityVersionId,
              kind: entity.kind,
              propertyId: property.id,
            },
          });
          return { status: "ok" };
        }

        const existingProvenance = existingMetadata?.flagProvenance ?? {};
        const now = new Date();
        const addedAt = now.toISOString();
        const lockProvenance = resolveLockProvenance({
          nextLocked,
          wasLocked,
          existingMetadata,
          userId: user.id,
          addedAt,
        });
        const metadata: CellMetadata = {
          version: 1,
          manualFlags,
          flagProvenance: Object.fromEntries(
            manualFlags.map((flag) => [
              flag,
              existingProvenance[flag] ?? {
                addedBy: user.id,
                addedAt,
              },
            ]),
          ),
          ...(nextLocked && { locked: true }),
          ...(lockProvenance && { lockProvenance }),
          ...carried,
        };

        await upsertCellMetadata({
          tx,
          workspaceId,
          entityVersionId,
          propertyId: property.id,
          metadata,
          userId: user.id,
          recordAuditEvent,
          changes,
          entity: { id: body.entityId, kind: entity.kind },
        });

        return { status: "ok" };
      }),
    );

    if (txResult.status === "entity-not-found") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Entity not found in workspace",
        }),
      );
    }

    if (txResult.status === "property-not-found") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Property not found in workspace",
        }),
      );
    }

    if (txResult.status === "no-override") {
      return Result.err(cellOverrideAbsentRefusal());
    }

    if (txResult.status === "entity-read-only") {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default updateCellMetadata;
