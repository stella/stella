import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { captureError } from "@/api/lib/posthog";
import { getSearchProvider } from "@/api/lib/search/provider";

export const renameEntityBodySchema = t.Object({
  entityId: tNanoid,
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

type RenameEntityBodySchema = Static<typeof renameEntityBodySchema>;

type RenameEntityHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: RenameEntityBodySchema;
};

export const renameEntityHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: RenameEntityHandlerProps) => {
  const entity = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: body.entityId,
        workspaceId: { eq: workspaceId },
      },
      columns: { id: true },
    }),
  );

  if (!entity) {
    return status(404, { message: "Entity not found" });
  }

  await scopedDb((tx) =>
    tx
      .update(entities)
      .set({ name: body.name, updatedAt: new Date() })
      .where(eq(entities.id, body.entityId)),
  );

  getSearchProvider().indexEntity(body.entityId).catch(captureError);

  return { entityId: body.entityId };
};
