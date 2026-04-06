import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const deleteContactParamsSchema = t.Object({
  contactId: tNanoid,
});

const deleteContactById = createRootHandler(
  {
    permissions: { contact: ["delete"] },
    params: deleteContactParamsSchema,
  },
  async ({ scopedDb, session, params }) =>
    await scopedDb(async (tx) => {
      const contact = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, params.contactId),
            eq(contacts.organizationId, session.activeOrganizationId),
          ),
        )
        .for("update")
        .limit(1)
        .then((rows) => rows.at(0) ?? null);

      if (!contact) {
        return status(404, { message: "Contact not found" });
      }

      const matterCount = await tx.$count(
        workspaces,
        and(
          eq(workspaces.clientId, params.contactId),
          eq(workspaces.organizationId, session.activeOrganizationId),
        ),
      );

      if (matterCount > 0) {
        return status(409, {
          message: `Reassign or delete ${matterCount} matter${
            matterCount === 1 ? "" : "s"
          } before deleting this contact`,
        });
      }

      try {
        await tx
          .delete(contacts)
          .where(
            and(
              eq(contacts.id, params.contactId),
              eq(contacts.organizationId, session.activeOrganizationId),
            ),
          );
      } catch (error) {
        if (isPgError(error, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
          return status(409, {
            message: "Reassign or delete matters before deleting this contact",
          });
        }
        throw error;
      }

      return;
    }),
);

export default deleteContactById;
