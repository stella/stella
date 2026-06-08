import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isWorkflowRunning, startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    entityId: tSafeId("entity"),
    propertyId: tSafeId("property"),
  }),
} satisfies HandlerConfig;

const cellRetry = createSafeHandler(
  config,
  async function* ({ workspaceId, session, user, scopedDb, safeDb, body }) {
    const { entityId, propertyId } = body;

    const property = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          columns: { id: true, tool: true },
          where: {
            id: { eq: propertyId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!property) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Property not found in workspace",
        }),
      );
    }

    if (property.tool.type !== "ai-model") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Property is not AI-extracted",
        }),
      );
    }

    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          columns: { id: true, currentVersionId: true, readOnly: true },
          where: {
            id: { eq: entityId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!entity?.currentVersionId) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Entity not found in workspace",
        }),
      );
    }
    if (entity.readOnly) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Entity is read-only",
        }),
      );
    }
    const entityVersionId = entity.currentVersionId;

    // Fail fast on locked cells so the user sees an explicit 409
    // instead of a silent no-op (the worker also skips locked cells
    // inside `processOneBatch`, so omitting this check would still be
    // safe — just user-hostile).
    const lockedRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ metadata: cellMetadata.metadata })
          .from(cellMetadata)
          .where(
            and(
              eq(cellMetadata.entityVersionId, entityVersionId),
              eq(cellMetadata.propertyId, propertyId),
            ),
          ),
      ),
    );
    if (lockedRows.at(0)?.metadata.locked === true) {
      return Result.err(
        new HandlerError({ status: 409, message: "Cell is locked" }),
      );
    }

    // Reject upfront when a workspace-wide workflow is already
    // running. Catches the common case without mutating the cell so
    // the user can retry once the workflow finishes. (A startWorkflow
    // call racing in afterwards is still handled below.)
    if (await isWorkflowRunning(workspaceId)) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A workflow is already running in this workspace",
        }),
      );
    }

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await startWorkflow({
            workspaceId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            scopedDb,
            entityIds: [entityId],
            propertyIds: [propertyId],
            serviceTier: "standard",
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );

    if (result.status === "already-running") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A workflow is already running in this workspace",
        }),
      );
    }
    if (result.status === "failed") {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to enqueue retry",
        }),
      );
    }

    return Result.ok(result);
  },
);

export default cellRetry;
