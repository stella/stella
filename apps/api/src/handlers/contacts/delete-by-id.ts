import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { contacts } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteContactParamsSchema = t.Object({
  contactId: tNanoid,
});

const deleteContactById = createRootHandler(
  {
    permissions: { contact: ["delete"] },
    params: deleteContactParamsSchema,
  },
  async ({ scopedDb, session, params }) => {
    const deletedRows = await scopedDb((tx) =>
      tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.id, params.contactId),
            eq(contacts.organizationId, session.activeOrganizationId),
          ),
        )
        .returning({ id: contacts.id }),
    );
    const deleted = deletedRows.at(0);

    if (!deleted) {
      return status(404, { message: "Contact not found" });
    }

    return;
  },
);

export default deleteContactById;
