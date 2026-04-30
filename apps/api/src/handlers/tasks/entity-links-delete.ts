import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { entityLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteEntityLinkBodySchema = t.Object({
  linkId: tSafeId("entityLink"),
});

const deleteEntityLink = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: deleteEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb }) {
    const link = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityLinks.findFirst({
          where: {
            id: { eq: body.linkId },
            workspaceId: { eq: workspaceId },
          },
          with: {
            sourceEntity: { columns: { kind: true, readOnly: true } },
            targetEntity: { columns: { kind: true, readOnly: true } },
          },
        }),
      ),
    );
    if (!link) {
      return Result.err(
        new HandlerError({ status: 404, message: "Link not found" }),
      );
    }
    if (
      link.sourceEntity?.kind !== "task" &&
      link.targetEntity?.kind !== "task"
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "This endpoint only manages task links",
        }),
      );
    }
    if (
      (link.sourceEntity?.kind === "task" && link.sourceEntity.readOnly) ||
      (link.targetEntity?.kind === "task" && link.targetEntity.readOnly)
    ) {
      return Result.err(
        new HandlerError({ status: 409, message: "Task is read-only" }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(entityLinks)
          .where(
            and(
              eq(entityLinks.id, body.linkId),
              eq(entityLinks.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    return Result.ok({ success: true });
  },
);

export default deleteEntityLink;
