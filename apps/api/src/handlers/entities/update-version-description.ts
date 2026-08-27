import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const bodySchema = t.Object({
  description: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
});

const config = {
  description:
    "Set or clear the free-text description on one version of a document, up " +
    "to 1024 characters. An annotation only: no file and no field value " +
    "changes. A version tombstoned by entities.delete-version is refused. " +
    "Use entities.update-version-label for the short label instead.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

type UpdateVersionDescriptionHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  description: string | null;
  recordAuditEvent: AuditRecorder;
};

export const updateVersionDescriptionHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
  description,
  recordAuditEvent,
}: UpdateVersionDescriptionHandlerProps) {
  const params = { entityId, versionId };
  const body = { description };
  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const existing = await tx
        .select({
          description: entityVersions.description,
          entityName: entities.name,
          kind: entities.kind,
          readOnly: entities.readOnly,
        })
        .from(entityVersions)
        .innerJoin(
          entities,
          and(
            eq(entities.id, entityVersions.entityId),
            eq(entities.workspaceId, entityVersions.workspaceId),
          ),
        )
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
            isNull(entityVersions.deletedAt),
          ),
        )
        .limit(1);
      const previous = existing.at(0);
      if (!previous) {
        return { status: "not-found" as const };
      }
      if (previous.readOnly) {
        return { status: "read-only" as const };
      }

      // Gate the write on liveness too, not just the pre-read: a delete-version
      // tombstoning this version between the SELECT and this UPDATE would
      // otherwise still let the annotation land on a withdrawn version. With the
      // predicate in the WHERE, the update affects zero rows in that race and
      // the handler returns 404.
      const updated = await tx
        .update(entityVersions)
        .set({ description: body.description })
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
            isNull(entityVersions.deletedAt),
          ),
        )
        .returning({ id: entityVersions.id });

      if (updated.length === 0) {
        return { status: "not-found" as const };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
        resourceId: params.versionId,
        metadata: {
          entityId: params.entityId,
          entityName: previous.entityName,
          kind: previous.kind,
        },
        changes: {
          description: {
            old: previous.description,
            new: body.description,
          },
        },
      });

      return { status: "updated" as const };
    }),
  );

  switch (outcome.status) {
    case "not-found": {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }
    case "read-only": {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }
    case "updated": {
      return Result.ok({ updated: true });
    }
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    return yield* updateVersionDescriptionHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
      description: body.description,
      recordAuditEvent,
    });
  },
);
