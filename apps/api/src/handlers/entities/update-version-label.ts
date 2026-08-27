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
  label: t.Union([t.String({ maxLength: 128 }), t.Null()]),
});

const config = {
  description:
    "Set or clear the short label on one version of a document, up to 128 " +
    "characters, for marking a version as a draft, an execution copy, and so " +
    "on. An annotation only, like entities.update-version-description, which " +
    "carries the longer note. A tombstoned version is refused.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

type UpdateVersionLabelHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  label: string | null;
  recordAuditEvent: AuditRecorder;
};

export const updateVersionLabelHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
  label,
  recordAuditEvent,
}: UpdateVersionLabelHandlerProps) {
  const params = { entityId, versionId };
  const body = { label };
  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const existing = await tx
        .select({
          entityName: entities.name,
          kind: entities.kind,
          label: entityVersions.label,
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
        .set({ label: body.label })
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
          label: {
            old: previous.label,
            new: body.label,
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
    return yield* updateVersionLabelHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
      label: body.label,
      recordAuditEvent,
    });
  },
);
