import { Result } from "better-result";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { abortTransaction, abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { kanbanPlacementRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FIELD_VALUE_WRITE_PERMISSIONS,
  upsertFieldContentSchema,
  writeFieldValue,
} from "@/api/lib/fields/write-field";
import type { FlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";
import { notifyFlowRunActorOfCompletion } from "@/api/lib/flows/flow-run-completion-notice";
import {
  FLOW_TASK_FEATURE_ACCESS,
  admitTaskFlowAccess,
  decideGateForTask,
} from "@/api/lib/flows/review-gate-task";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";

const fieldAssignmentSchema = t.Object({
  propertyId: tSafeId("property"),
  content: upsertFieldContentSchema,
});

const transactionSafeDb =
  (tx: Transaction): SafeDb =>
  async (operation) =>
    await Result.tryPromise(async () => await operation(tx));

export const createUpdateKanbanPlacement = ({
  flushSearchRepairs = flushEntitySearchRepairs,
}: {
  flushSearchRepairs?: typeof flushEntitySearchRepairs;
} = {}) =>
  createSafeHandler(
    {
      description:
        "Move one entity across writable Kanban axes in one transaction. " +
        "The request may change a task status, up to two property values, or both.",
      permissions: FIELD_VALUE_WRITE_PERMISSIONS,
      accountAccess: ACCOUNT_ACCESS.sandbox,
      featureAccess: FLOW_TASK_FEATURE_ACCESS,
      realtime: kanbanPlacementRealtimeUpdates,
      mcp: {
        type: "capability",
        reason: "workspace_schema",
        consumesServices: false,
      },
      body: t.Object({
        entityId: tSafeId("entity"),
        status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
        fields: t.Array(fieldAssignmentSchema, { maxItems: 2 }),
      }),
    },
    async function* ({
      safeDb,
      workspaceId,
      body,
      user,
      memberRole,
      recordAuditEvent,
    }) {
      const admission = yield* Result.await(
        safeDb(
          async (tx) =>
            await admitTaskFlowAccess(tx, {
              access: "read",
              workspaceId,
              taskEntityId: body.entityId,
              userId: user.id,
            }),
        ),
      );
      yield* admission;
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
      const completionNotices: FlowRunCompletionNotice[] = [];

      yield* Result.await(
        abortableTx(safeDb, async (tx) => {
          const currentAdmission = await admitTaskFlowAccess(tx, {
            access: "write",
            workspaceId,
            taskEntityId: body.entityId,
            userId: user.id,
          });
          if (currentAdmission.isErr()) {
            abortTransaction(currentAdmission.error);
          }
          const txSafeDb = transactionSafeDb(tx);

          if (status !== undefined) {
            const taskResult = await Result.gen(() =>
              updateTaskHandler({
                safeDb: txSafeDb,
                workspaceId,
                userId: user.id,
                recordAuditEvent,
                body: { taskId: body.entityId, status },
                decideGate: async (options) =>
                  await decideGateForTask(options, {
                    notifyRunCompleted: (notice) => {
                      completionNotices.push(notice);
                    },
                  }),
              }),
            );
            if (Result.isError(taskResult)) {
              throw taskResult.error;
            }
          }

          // db-await-in-loop: each assignment runs the full field upsert (validation, audit); the schema caps a move at two
          const fieldResults = await Promise.all(
            body.fields.map(
              async (field) =>
                await Result.gen(() =>
                  writeFieldValue({
                    safeDb: txSafeDb,
                    authority: memberRole,
                    workspaceId,
                    userId: user.id,
                    recordAuditEvent,
                    entityId: body.entityId,
                    propertyId: field.propertyId,
                    content: field.content,
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

      // A completion pointer uses the owner connection. File it only after the
      // outer transaction releases its workspace/run locks and commits the move.
      await Promise.all(
        completionNotices.map(
          async (notice) =>
            await notifyFlowRunActorOfCompletion(notice).catch(captureError),
        ),
      );

      if (body.fields.length > 0) {
        flushSearchRepairs([body.entityId]).catch(captureError);
      }
      return Result.ok({});
    },
  );

export default createUpdateKanbanPlacement();
