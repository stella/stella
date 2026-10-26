import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { countWorkflowTargetEntities } from "@/api/lib/workflow-target-queries";

const config = {
  contract: "patch",
  description:
    "Count the documents an extraction workflow would process in a matter, " +
    "optionally narrowed to a set of entity ids. Use it before " +
    "matters.workflow.start to size the run.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  body: v.object({
    entityIds: v.optional(
      v.pipe(
        v.array(resourceIdSchema("entity")),
        v.maxLength(LIMITS.entitiesCount),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const workflowTargetCount = createSafeHandler(
  config,
  async function* ({ body, scopedDb, workspaceId }) {
    const count = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await countWorkflowTargetEntities({
            scopedDb,
            workspaceId,
            ...(body.entityIds !== undefined &&
              body.entityIds.length > 0 && { inputEntityIds: body.entityIds }),
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );

    return Result.ok({ count });
  },
);

export default workflowTargetCount;
