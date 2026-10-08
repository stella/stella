import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { entities, fields, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { insertEntityVersion } from "@/api/lib/entity-versions/insert-entity-version";
import {
  buildVersionStamp,
  nextEntityVersionNumber,
} from "@/api/lib/entity-versions/version-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FLOW_TASK_FEATURE_ACCESS } from "@/api/lib/flows/review-gate-task";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { processExtraction } from "@/api/lib/search/process-extraction";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const config = {
  description:
    "Restore a historical document version by copying it into a new current version; the prior history remains intact.",
  permissions: { entity: ["update"] },
  featureAccess: FLOW_TASK_FEATURE_ACCESS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  params: paramsSchema,
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, user, recordAuditEvent }) {
    const userId = user.id;

    const nextVersionId = createSafeId<"entityVersion">();

    // Create a new version (copy-to-top) with all fields from the source version
    const restoreOutcome = yield* Result.await(
      safeDb(async (tx) => {
        const admission = await admitTaskFlowMutation(tx, {
          workspaceId,
          userId,
          target: { type: "entities", entityIds: [params.entityId] },
        });
        if (Result.isError(admission)) {
          return { status: "denied" as const, error: admission.error };
        }
        // The entity lock serializes restore and tombstone; source metadata is
        // read only after admission and under that lock in the effect transaction.
        const entity = (
          await tx
            .select({
              id: entities.id,
              docSequence: entities.docSequence,
              readOnly: entities.readOnly,
              currentVersionId: entities.currentVersionId,
            })
            .from(entities)
            .where(
              and(
                eq(entities.id, params.entityId),
                eq(entities.workspaceId, workspaceId),
              ),
            )
            .for("update")
        ).at(0);
        if (!entity) {
          return { status: "not-found" as const };
        }
        if (entity.readOnly) {
          return { status: "read-only" as const };
        }
        const version = await tx.query.entityVersions.findFirst({
          where: {
            id: { eq: params.versionId },
            entityId: { eq: params.entityId },
            workspaceId: { eq: workspaceId },
            deletedAt: { isNull: true },
          },
          columns: { id: true, versionNumber: true },
          with: { fields: { columns: { content: true, propertyId: true } } },
        });
        if (!version) {
          return { status: "not-found" as const };
        }
        const workspace = await tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { reference: true },
        });
        const previousCurrentVersionId = entity.currentVersionId;

        // Allocate from MAX over all versions (incl. tombstoned) under the
        // entity lock, not source/current + 1, and inside the mutation tx so
        // concurrent restores serialize instead of racing to the same number.
        const nextVersionNumber = await nextEntityVersionNumber(tx, {
          entityId: params.entityId,
          workspaceId,
        });
        const nextVersionStamp = buildVersionStamp({
          docSequence: entity.docSequence,
          versionNumber: nextVersionNumber,
          workspaceReference: workspace?.reference ?? null,
        });

        await insertEntityVersion(tx, {
          createdBy: userId,
          entityId: params.entityId,
          id: nextVersionId,
          label: `Restored from v${String(version.versionNumber)}`,
          stamp: nextVersionStamp.stamp,
          versionNumber: nextVersionNumber,
          workspaceId,
        });

        // Clone all fields from the source version
        if (version.fields.length > 0) {
          await tx.insert(fields).values(
            version.fields.map((f) => ({
              content: f.content,
              entityVersionId: nextVersionId,
              propertyId: f.propertyId,
              workspaceId,
            })),
          );
        }

        // Point entity to the new version

        await tx
          .update(entities)
          .set({
            currentVersionId: nextVersionId,
            lastEditedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(entities.id, params.entityId));

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            resourceId: nextVersionId,
            changes: {
              created: {
                old: null,
                new: {
                  entityId: params.entityId,
                  versionNumber: nextVersionNumber,
                  restoredFromVersionId: params.versionId,
                  restoredFromVersionNumber: version.versionNumber,
                },
              },
            },
            metadata: {
              restoredFromVersionId: params.versionId,
            },
          },
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: params.entityId,
            changes: {
              currentVersionId: {
                old: previousCurrentVersionId,
                new: nextVersionId,
              },
            },
          },
        ]);

        return {
          status: "restored" as const,
          versionNumber: nextVersionNumber,
        };
      }),
    );

    switch (restoreOutcome.status) {
      case "denied":
        return Result.err(restoreOutcome.error);
      case "not-found":
        return Result.err(
          new HandlerError({ status: 404, message: "Version not found" }),
        );
      case "read-only":
        return Result.err(
          new HandlerError({ status: 409, message: "Entity is read-only" }),
        );
      case "restored":
        break;
      default:
        restoreOutcome satisfies never;
        return panic("Unknown version restore outcome");
    }

    // The restore creates a brand-new current version. Queue extraction (or a
    // metadata-only index for entities without an extractable file) so the
    // search freshness fence does not hide the restored entity indefinitely.
    await processExtraction(params.entityId).catch((error: unknown) =>
      captureError(error, {
        entityId: params.entityId,
        versionId: nextVersionId,
      }),
    );

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.ENTITY, id: params.entityId }),
    );

    return Result.ok({
      versionId: nextVersionId,
      versionNumber: restoreOutcome.versionNumber,
    });
  },
);
