import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const manualFlagsSchema = t.Array(t.String({ minLength: 1, maxLength: 64 }), {
  maxItems: 16,
});

const config = {
  permissions: {
    entity: ["update"],
  },
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
  | { status: "property-not-found" };

const normalizeManualFlags = (flags: string[]) =>
  [...new Set(flags)].toSorted();

const mergeManualFlags = ({
  baseManualFlags,
  currentManualFlags,
  requestedManualFlags,
}: {
  baseManualFlags: string[];
  currentManualFlags: string[];
  requestedManualFlags: string[];
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
          existingMetadata?.manualFlags ?? [],
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

    return Result.ok({ success: true });
  },
);

export default updateCellMetadata;
