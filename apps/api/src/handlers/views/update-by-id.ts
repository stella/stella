import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { views } from "@/api/db/schema";
import { viewConfigSchema, viewLayoutSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateViewBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  layout: t.Optional(viewLayoutSchema),
  config: t.Optional(viewConfigSchema),
});

type UpdateViewBodySchema = Static<typeof updateViewBodySchema>;

type UpdateViewHandlerProps = {
  viewId: string;
  workspaceId: SafeId<"workspace">;
  body: UpdateViewBodySchema;
};

export const updateViewHandler = async ({
  viewId,
  workspaceId,
  body,
}: UpdateViewHandlerProps) => {
  // Explicitly pick only known view columns to avoid leaking
  // extra body fields (e.g. queryKey from the invalidateQuery
  // macro) into the Drizzle SET clause.
  //
  // NOTE: Elysia coerces absent optional UnionEnum fields to
  // their first value (e.g. layout → "table"). All callers
  // must send the current layout/config to prevent corruption.
  const updates = pickDefined(body, ["name", "layout", "config"]);

  if (Object.keys(updates).length === 0) {
    return;
  }

  const [updated] = await db
    .update(views)
    .set(updates)
    .where(and(eq(views.id, viewId), eq(views.workspaceId, workspaceId)))
    .returning({ id: views.id });

  if (!updated) {
    return status(404, { message: "View not found" });
  }

  return;
};
