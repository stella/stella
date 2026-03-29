import { and, count, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const readContactByIdParamsSchema = t.Object({
  contactId: tNanoid,
});

const readContactById = createRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: readContactByIdParamsSchema,
  },
  async ({ scopedDb, session, params }) => {
    const contact = await scopedDb((tx) =>
      tx.query.contacts.findFirst({
        where: {
          id: params.contactId,
          organizationId: { eq: session.activeOrganizationId },
        },
        with: {
          originatingAttorney: {
            columns: { id: true, name: true, image: true },
          },
          responsibleAttorney: {
            columns: { id: true, name: true, image: true },
          },
        },
      }),
    );

    if (!contact) {
      return status(404, { message: "Contact not found" });
    }

    const clientMatters = await scopedDb((tx) =>
      tx.query.workspaces.findMany({
        where: {
          clientId: params.contactId,
          organizationId: { eq: session.activeOrganizationId },
          status: "active",
        },
        columns: {
          id: true,
          name: true,
          color: true,
          createdAt: true,
        },
        limit: LIMITS.workspacesCount,
      }),
    );

    const [partyMatters] = await scopedDb((tx) =>
      tx
        .select({ count: count() })
        .from(workspaceContacts)
        .where(
          and(
            eq(workspaceContacts.contactId, params.contactId),
            eq(workspaceContacts.organizationId, session.activeOrganizationId),
          ),
        ),
    );

    return {
      ...contact,
      clientMatters,
      partyCount: partyMatters?.count ?? 0,
    };
  },
);

export default readContactById;
