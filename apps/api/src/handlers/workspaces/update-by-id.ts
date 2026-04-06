import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    clientId: t.Optional(tNanoid),
    reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
    billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  }),
} satisfies HandlerConfig;

// Workspace name is fetched via JOIN at search time;
// no reindex needed on rename.
const updateWorkspace = createHandler(
  config,
  async ({ scopedDb, session, workspaceId, body }) =>
    await scopedDb(async (tx) => {
      if (body.clientId) {
        const client = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, body.clientId),
              eq(contacts.organizationId, session.activeOrganizationId),
            ),
          )
          .for("update")
          .limit(1)
          .then((rows) => rows.at(0) ?? null);

        if (!client) {
          return status(404, {
            message: "Client not found",
          });
        }
      }

      try {
        return await tx
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
          .where(eq(workspaces.id, workspaceId));
      } catch (error) {
        if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
          return status(409, {
            message: "Duplicate value",
          });
        }
        throw error;
      }
    }),
);

export default updateWorkspace;
