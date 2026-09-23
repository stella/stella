import { panic, Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const VERSION_ANNOTATION_COLUMNS = {
  label: entityVersions.label,
  description: entityVersions.description,
} as const;

type VersionAnnotation = {
  field: keyof typeof VERSION_ANNOTATION_COLUMNS;
  value: string | null;
};

export type VersionAnnotationTarget = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  recordAuditEvent: AuditRecorder;
};

type UpdateVersionAnnotationOptions = VersionAnnotationTarget & {
  annotation: VersionAnnotation;
};

/**
 * Set or clear one free-text annotation on a live version of a document.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const updateVersionAnnotation = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
  recordAuditEvent,
  annotation: { field, value },
}: UpdateVersionAnnotationOptions) {
  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const existing = await tx
        .select({
          entityName: entities.name,
          kind: entities.kind,
          annotation: VERSION_ANNOTATION_COLUMNS[field],
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
            eq(entityVersions.id, versionId),
            eq(entityVersions.entityId, entityId),
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
        .set(field === "label" ? { label: value } : { description: value })
        .where(
          and(
            eq(entityVersions.id, versionId),
            eq(entityVersions.entityId, entityId),
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
        resourceId: versionId,
        metadata: {
          entityId,
          entityName: previous.entityName,
          kind: previous.kind,
        },
        changes: {
          [field]: {
            old: previous.annotation,
            new: value,
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
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
    }
  }
};
