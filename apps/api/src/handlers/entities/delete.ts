import { Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  workspaces,
} from "@/api/db/schema";
import {
  extractFieldFileRefs,
  filterUnreferencedFieldFileRefs,
} from "@/api/handlers/files/field-file-refs";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const deleteEntitiesBodySchema = t.Object({
  entityIds: t.Array(tSafeId("entity"), {
    minItems: 1,
    maxItems: LIMITS.entitiesPageSizeMax,
  }),
});

type DeleteEntitiesBodySchema = Static<typeof deleteEntitiesBodySchema>;

export type DeleteEntitiesHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: DeleteEntitiesBodySchema;
};

export const deleteEntitiesHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
}: DeleteEntitiesHandlerProps) {
  const txOutcome = yield* Result.await(
    safeDb(async (tx) => {
      // OCR dispatch takes this same entity fence before changing a run to
      // `running`. Lock the bounded request in deterministic order and retain
      // the locks through storage cleanup and the database delete: a withdrawn
      // document can then never begin processing after cleanup has started.
      const lockedEntities = await tx
        .select({ id: entities.id, readOnly: entities.readOnly })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, body.entityIds),
          ),
        )
        .orderBy(asc(entities.id))
        .limit(LIMITS.entitiesPageSizeMax)
        .for("update");
      if (lockedEntities.some(({ readOnly }) => readOnly)) {
        return {
          status: "rejected" as const,
          error: new HandlerError({
            status: 409,
            message: "Entity is read-only",
          }),
        };
      }

      const runningOcrRuns = await tx
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.workspaceId, workspaceId),
            inArray(documentProcessingRuns.entityId, body.entityIds),
            eq(documentProcessingRuns.status, "running"),
          ),
        )
        .limit(1);
      if (runningOcrRuns.at(0)) {
        return {
          status: "rejected" as const,
          error: new HandlerError({
            status: 409,
            message: "Wait for document processing to finish before deleting",
          }),
        };
      }

      const entityVersionIds = tx
        .select({ id: entityVersions.id })
        .from(entityVersions)
        .innerJoin(entities, eq(entityVersions.entityId, entities.id))
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, body.entityIds),
          ),
        );

      const fieldRows = await tx
        .select({ content: fields.content })
        .from(fields)
        .where(inArray(fields.entityVersionId, entityVersionIds));

      const fileRefs = fieldRows.flatMap((row) =>
        extractFieldFileRefs(row.content),
      );
      const unreferencedFileRefs = await filterUnreferencedFieldFileRefs({
        tx,
        workspaceId,
        fileRows: fileRefs,
        excludedEntityIds: body.entityIds,
      });

      // Storage cannot join the database transaction. Holding the entity fence
      // across this bounded cleanup is deliberate: cleanup failure rolls the
      // transaction back, while successful cleanup is immediately followed by
      // the owning-row delete before any OCR dispatch can acquire the fence.
      Result.unwrap(
        await deleteS3Objects({
          fileRows: unreferencedFileRefs,
          organizationId,
          workspaceId,
        }),
        "Entity file cleanup must succeed before deleting database records",
      );

      // Cascade: entities → entityVersions → fields →
      // justifications (all cascade).
      const deleted = await tx
        .delete(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, body.entityIds),
          ),
        )
        .returning({
          id: entities.id,
          kind: entities.kind,
          name: entities.name,
          parentId: entities.parentId,
        });

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await recordAuditEvent(
        tx,
        deleted.map((entity) => ({
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entity.id,
          changes: {
            deleted: {
              old: {
                kind: entity.kind,
                name: entity.name,
                parentId: entity.parentId,
              },
              new: null,
            },
          },
        })),
      );

      return { status: "deleted" as const, entities: deleted };
    }),
  );
  if (txOutcome.status === "rejected") {
    return Result.err(txOutcome.error);
  }
  const deletedEntities = txOutcome.entities;

  // Explicit removal for non-PG providers (CASCADE handles PG)
  const provider = getSearchProvider();
  for (const entity of deletedEntities) {
    provider
      .removeEntity({ entityId: entity.id, workspaceId })
      .catch(captureError);
  }

  return Result.ok({});
};

const config = {
  permissions: { entity: ["delete"] },
  mcp: { type: "tool", name: "delete_document" },
  body: deleteEntitiesBodySchema,
} satisfies HandlerConfig;

const deleteEntities = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* deleteEntitiesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteEntities;
