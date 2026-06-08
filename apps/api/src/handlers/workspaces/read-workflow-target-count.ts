import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { countWorkflowTargetEntities } from "@/api/lib/workflow-target-queries";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    entityIds: t.Optional(t.Array(tSafeId("entity"))),
  }),
} satisfies HandlerConfig;

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
