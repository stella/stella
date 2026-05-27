import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startWorkflow } from "@/api/lib/workflow-queue";

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

    // Reset the cell to `pending` so the workflow's skip logic
    // (`prepareBatch`) treats it as work-to-do regardless of the
    // property's `fresh`/`stale` status. The same write also refuses to
    // run when the cell is manually locked — the locked snapshot is the
    // user's explicit override and the AI must not stomp it.
    const resetOutcome = yield* Result.await(
      safeDb(async (tx) => {
        const lockedRows = await tx
          .select({ metadata: cellMetadata.metadata })
          .from(cellMetadata)
          .where(
            and(
              eq(cellMetadata.entityVersionId, entityVersionId),
              eq(cellMetadata.propertyId, propertyId),
            ),
          );
        if (lockedRows.at(0)?.metadata.locked === true) {
          return "locked" as const;
        }

        // audit: skip — placeholder reset mirrors the workflow's own
        // pending-state writes, which are not audited.
        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.entityVersionId, entityVersionId),
              eq(fields.propertyId, propertyId),
            ),
          );

        // audit: skip — see comment above the matching delete.
        await tx.insert(fields).values({
          id: createSafeId<"field">(),
          workspaceId,
          propertyId,
          entityVersionId,
          content: { type: "pending", version: 1 },
        });

        return "reset" as const;
      }),
    );

    if (resetOutcome === "locked") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Cell is locked",
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
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );

    return Result.ok(result);
  },
);

export default cellRetry;
