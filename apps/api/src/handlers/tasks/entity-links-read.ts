import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const listEntityLinksParamsSchema = workspaceParams({
  taskId: tSafeId("entity"),
});

const listEntityLinks = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: listEntityLinksParamsSchema,
  },
  async function* ({ workspaceId, params, safeDb }) {
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: params.taskId },
            workspaceId: { eq: workspaceId },
            kind: { eq: "task" },
          },
          columns: { id: true },
        }),
      ),
    );
    if (!entity) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }

    const [asSource, asTarget] = yield* Result.await(
      safeDb(
        async (tx) =>
          await Promise.all([
            tx.query.entityLinks.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                sourceEntityId: { eq: params.taskId },
              },
              with: {
                sourceEntity: {
                  columns: { id: true, name: true, kind: true },
                },
                targetEntity: {
                  columns: { id: true, name: true, kind: true },
                },
              },
              limit: 200,
            }),
            tx.query.entityLinks.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                targetEntityId: { eq: params.taskId },
              },
              with: {
                sourceEntity: {
                  columns: { id: true, name: true, kind: true },
                },
                targetEntity: {
                  columns: { id: true, name: true, kind: true },
                },
              },
              limit: 200,
            }),
          ]),
      ),
    );

    return Result.ok([...asSource, ...asTarget]);
  },
);

export default listEntityLinks;
