import { status, t } from "elysia";

import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const listEntityLinksParamsSchema = t.Object({
  taskId: tNanoid,
});

const listEntityLinks = createHandler(
  {
    permissions: { workspace: ["read"] },
    params: listEntityLinksParamsSchema,
  },
  async ({ workspaceId, params, scopedDb }) => {
    const entity = await scopedDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: params.taskId,
          workspaceId: { eq: workspaceId },
          kind: "task",
        },
        columns: { id: true },
      }),
    );
    if (!entity) {
      return status(404, { message: "Task not found" });
    }

    const [asSource, asTarget] = await scopedDb(
      async (tx) =>
        await Promise.all([
          tx.query.entityLinks.findMany({
            where: {
              workspaceId: { eq: workspaceId },
              sourceEntityId: params.taskId,
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
              targetEntityId: params.taskId,
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
    );

    return [...asSource, ...asTarget];
  },
);

export default listEntityLinks;
