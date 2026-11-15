import { Result } from "better-result";

import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteTaskParamsSchema = workspaceParams({
  taskId: resourceIdSchema("entity"),
});

/**
 * `DELETE /v1/tasks/:workspaceId/:taskId`: one task, and only a task. The
 * delete itself is the matter's entity delete, so a task leaves the same
 * way from every surface; this route only refuses anything that is not a
 * task in the matter, so a tasks consent can never delete a document.
 */
const deleteTask = createSafeHandler(
  {
    contract: "patch",
    description:
      "Permanently delete one task from its matter, together with its " +
      "links, assignees and field values. Refused while the matter is " +
      "archived or the task is read-only. This is irreversible.",
    permissions: { entity: ["delete"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "delete_task" },
    params: deleteTaskParamsSchema,
  },
  async function* ({ params, recordAuditEvent, safeDb, session, workspaceId }) {
    const task = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          columns: { id: true },
          where: {
            id: { eq: params.taskId },
            workspaceId: { eq: workspaceId },
            kind: { eq: "task" },
          },
        }),
      ),
    );
    if (!task) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Task not found",
        }),
      );
    }
    return yield* deleteEntitiesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body: { entityIds: [params.taskId] },
    });
  },
);

declareAggregateMutation(deleteTask, {
  type: "independent",
  reason:
    "Deletes one task through the matter's entity delete, which serializes on the matter's own advisory lock and locks the matter row before it writes; it owns no registered aggregate.",
});

export default deleteTask;
