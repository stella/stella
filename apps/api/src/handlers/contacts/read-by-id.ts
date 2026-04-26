import { Result } from "better-result";
import { and, count, eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const readContactByIdParamsSchema = t.Object({
  contactId: tSafeId("contact"),
});

const readContactById = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: readContactByIdParamsSchema,
  },
  async function* ({ safeDb, session, params }) {
    const contact = yield* Result.await(
      safeDb((tx) =>
        tx.query.contacts.findFirst({
          where: {
            id: { eq: params.contactId },
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
      ),
    );

    if (!contact) {
      return Result.err(
        new HandlerError({ status: 404, message: "Contact not found" }),
      );
    }

    const clientMatters = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            clientId: { eq: params.contactId },
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
      ),
    );

    const [partyMatters] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ count: count() })
          .from(workspaceContacts)
          .where(
            and(
              eq(workspaceContacts.contactId, params.contactId),
              eq(
                workspaceContacts.organizationId,
                session.activeOrganizationId,
              ),
            ),
          ),
      ),
    );

    return Result.ok({
      ...contact,
      clientMatters,
      partyCount: partyMatters?.count ?? 0,
    });
  },
);

export default readContactById;
