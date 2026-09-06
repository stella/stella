import { Result } from "better-result";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  upsertFieldContentSchema,
  upsertFieldHandler,
} from "@/api/handlers/fields/upsert-by-id";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";

const fieldAssignmentSchema = t.Object({
  propertyId: tSafeId("property"),
  content: upsertFieldContentSchema,
});

const transactionSafeDb =
  (tx: Transaction): SafeDb =>
  async (operation) =>
    await Result.tryPromise(async () => await operation(tx));

const updateKanbanPlacement = createSafeHandler(
  {
    description:
      "Move one entity across writable Kanban axes in one transaction. " +
      "The request may change a task status, up to two property values, or both.",
    permissions: { entity: ["create", "update"] },
    mcp: { type: "capability", reason: "workspace_schema" },
    body: t.Object({
      entityId: tSafeId("entity"),
      status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
      fields: t.Array(fieldAssignmentSchema, { maxItems: 2 }),
    }),
  },
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    if (body.status === undefined && body.fields.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "Kanban move is empty" }),
      );
    }

    const propertyIds = new Set(
      body.fields.map(({ propertyId }) => propertyId),
    );
    if (propertyIds.size !== body.fields.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Kanban move contains duplicate properties",
        }),
      );
    }
    const status = body.status;

    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const txSafeDb = transactionSafeDb(tx);

        if (status !== undefined) {
          const taskResult = await Result.gen(() =>
            updateTaskHandler({
              safeDb: txSafeDb,
              workspaceId,
              userId: user.id,
              recordAuditEvent,
              body: { taskId: body.entityId, status },
            }),
          );
          if (Result.isError(taskResult)) {
            throw taskResult.error;
          }
        }

        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded: the request schema caps a kanban move at two field assignments
        const fieldResults = await Promise.all(
          body.fields.map(
            async (field) =>
              await Result.gen(() =>
                upsertFieldHandler({
                  safeDb: txSafeDb,
                  workspaceId,
                  userId: user.id,
                  recordAuditEvent,
                  body: { entityId: body.entityId, ...field },
                  flushSearchRepairs: false,
                }),
              ),
          ),
        );
        const fieldError = fieldResults.find(Result.isError);
        if (fieldError) {
          throw fieldError.error;
        }
      }),
    );

    if (body.fields.length > 0) {
      flushEntitySearchRepairs([body.entityId]).catch(captureError);
    }
    return Result.ok({});
  },
);

export default updateKanbanPlacement;
