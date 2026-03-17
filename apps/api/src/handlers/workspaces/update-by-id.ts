import { eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaces } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    clientId: t.Optional(t.Nullable(tNanoid)),
    reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
    billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  }),
} satisfies HandlerConfig;

// Workspace name is fetched via JOIN at search time;
// no reindex needed on rename.
const updateWorkspace = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) => {
    try {
      return await scopedDb((tx) =>
        tx
          .update(workspaces)
          .set(
            pickDefined(body, [
              "name",
              "clientId",
              "reference",
              "billingReference",
              "color",
            ]),
          )
          .where(eq(workspaces.id, workspaceId)),
      );
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        return status(409, {
          message: "Duplicate value",
        });
      }
      throw error;
    }
  },
);

export default updateWorkspace;
