import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { REVIEW_FLAGS, REVIEW_FLAGS_MAX_ITEMS } from "@stll/api-contract";
import type { ReviewFlag } from "@stll/api-contract";

import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// The wire vocabulary is the column's vocabulary: a flag the cell control
// cannot render is one this endpoint refuses rather than stores.
const manualFlagsSchema = t.Array(t.UnionEnum([...REVIEW_FLAGS]), {
  maxItems: REVIEW_FLAGS_MAX_ITEMS,
});

const config = {
  description:
    "Set the manual flags and lock state of one cell, meaning one document's " +
    "value for one property. manualFlags is merged against baseManualFlags " +
    "rather than overwritten, so flags added or removed by someone else " +
    "since you read the cell survive; when no flags remain and the cell is " +
    "not locked, the metadata row is deleted. Use fields.upsert-by-id to " +
    "change the cell's value itself, and fields.mark-column-flag to flag a " +
    "whole column at once.",
  permissions: {
    entity: ["update"],
  },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: t.Object({
    propertyId: tSafeId("property"),
    entityId: tSafeId("entity"),
    baseManualFlags: t.Optional(manualFlagsSchema),
    manualFlags: manualFlagsSchema,
    locked: t.Optional(t.Boolean()),
  }),
} satisfies HandlerConfig;

type UpdateCellMetadataResult =
  | { status: "ok" }
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

        if (manualFlags.length === 0 && !nextLocked) {
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
        };

        await tx
          .insert(cellMetadata)
          .values({
            workspaceId,
            entityVersionId,
            propertyId: property.id,
            metadata,
            createdBy: user.id,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
            set: {
              metadata,
              updatedBy: user.id,
              updatedAt: new Date(),
            },
          });

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

    if (txResult.status === "entity-read-only") {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default updateCellMetadata;
