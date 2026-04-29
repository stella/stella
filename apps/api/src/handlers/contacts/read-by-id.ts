import { Result } from "better-result";
import { and, countDistinct, desc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { workspaceContacts, workspaces } from "@/api/db/schema";
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

    const partyMatterRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            color: workspaces.color,
            createdAt: workspaces.createdAt,
            id: workspaces.id,
            name: workspaces.name,
            roles: sql<(typeof workspaceContacts.$inferSelect.role)[]>`
              array_agg(${workspaceContacts.role})
            `,
          })
          .from(workspaceContacts)
          .innerJoin(
            workspaces,
            and(
              eq(workspaceContacts.workspaceId, workspaces.id),
              eq(workspaces.organizationId, session.activeOrganizationId),
            ),
          )
          .where(
            and(
              eq(workspaceContacts.contactId, params.contactId),
              eq(
                workspaceContacts.organizationId,
                session.activeOrganizationId,
              ),
              eq(workspaces.status, "active"),
            ),
          )
          .groupBy(
            workspaces.id,
            workspaces.name,
            workspaces.color,
            workspaces.createdAt,
          )
          .orderBy(desc(workspaces.createdAt), workspaces.id)
          .limit(LIMITS.workspaceContactsCount),
      ),
    );

    const [partyCountRow] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ total: countDistinct(workspaceContacts.workspaceId) })
          .from(workspaceContacts)
          .innerJoin(
            workspaces,
            and(
              eq(workspaceContacts.workspaceId, workspaces.id),
              eq(workspaces.organizationId, session.activeOrganizationId),
            ),
          )
          .where(
            and(
              eq(workspaceContacts.contactId, params.contactId),
              eq(
                workspaceContacts.organizationId,
                session.activeOrganizationId,
              ),
              eq(workspaces.status, "active"),
            ),
          ),
      ),
    );

    return Result.ok({
      ...contact,
      clientMatters,
      partyMatters: partyMatterRows,
      partyCount: partyCountRow?.total ?? 0,
    });
  },
);

export default readContactById;
