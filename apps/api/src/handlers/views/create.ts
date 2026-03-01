import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { views } from "@/api/db/schema";
import { viewConfigSchema, viewLayoutSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createViewBodySchema = t.Object({
  id: tNanoid,
  name: tDefaultVarchar,
  layout: viewLayoutSchema,
  config: viewConfigSchema,
});

type CreateViewBodySchema = Static<typeof createViewBodySchema>;

type CreateViewHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: CreateViewBodySchema;
};

export const createViewHandler = ({
  workspaceId,
  body,
}: CreateViewHandlerProps) => {
  return db.transaction(async (tx) => {
    const lockedViews = await tx
      .select({ id: views.id, position: views.position })
      .from(views)
      .where(eq(views.workspaceId, workspaceId))
      .for("update");

    if (lockedViews.length >= LIMITS.viewsCount) {
      return status(400, {
        message: "Views limit reached",
      });
    }

    const maxPosition = lockedViews.reduce(
      (max, v) => (v.position > max ? v.position : max),
      -1,
    );

    const created = await tx
      .insert(views)
      .values({
        id: body.id,
        workspaceId,
        name: body.name,
        layout: body.layout,
        config: body.config,
        position: maxPosition + 1,
      })
      .returning()
      .then((rows) => rows.at(0));

    if (!created) {
      return status(500, { message: "Failed to create view" });
    }

    return created;
  });
};
