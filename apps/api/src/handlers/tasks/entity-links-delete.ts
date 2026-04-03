import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { entityLinks } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteEntityLinkBodySchema = t.Object({
  linkId: tNanoid,
});

const deleteEntityLink = createHandler(
  {
    permissions: { entity: ["update"] },
    body: deleteEntityLinkBodySchema,
  },
  async ({ workspaceId, body, scopedDb }) => {
    const link = await scopedDb((tx) =>
      tx.query.entityLinks.findFirst({
        where: {
          id: body.linkId,
          workspaceId: { eq: workspaceId },
        },
        with: {
          sourceEntity: { columns: { kind: true } },
          targetEntity: { columns: { kind: true } },
        },
      }),
    );
    if (!link) {
      return status(404, { message: "Link not found" });
    }
    if (
      link.sourceEntity?.kind !== "task" &&
      link.targetEntity?.kind !== "task"
    ) {
      return status(400, {
        message: "This endpoint only manages task links",
      });
    }

    await scopedDb((tx) =>
      tx
        .delete(entityLinks)
        .where(
          and(
            eq(entityLinks.id, body.linkId),
            eq(entityLinks.workspaceId, workspaceId),
          ),
        ),
    );

    return { success: true };
  },
);

export default deleteEntityLink;
