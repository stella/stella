import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
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
    mcp: { type: "tool", name: "read_contact" },
    params: readContactByIdParamsSchema,
  },
  async function* ({ safeDb, session, params }) {
    // One shared scoped transaction for the whole read-only sequence: the
    // contact row, the two client-matter reads (count across all statuses,
    // rows scoped to active), and the party-matters page. All reads are
    // scoped by organizationId/contactId directly, so one transaction is
    // semantically identical to the independent transactions this replaced,
    // while paying for a single `set_config`.
    const reads = yield* Result.await(
      safeDb(async (tx) => {
        const contact = await tx.query.contacts.findFirst({
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
        });

        // Not merged with clientMatters below: this counts matters across
        // all statuses, while clientMatters is scoped to active only.

        const clientMatterCount = await tx.$count(
          workspaces,
          and(
            eq(workspaces.clientId, params.contactId),
            eq(workspaces.organizationId, session.activeOrganizationId),
          ),
        );

        const clientMatters = await tx.query.workspaces.findMany({
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
        });

        // `count(*) OVER()` computes the total matching-group count after
        // GROUP BY and before LIMIT/ORDER BY apply, so the page's
        // LIMIT.workspaceContactsCount cap does not affect it. This replaces
        // a separate countDistinct query that reran the same join/predicate.

        const partyMatterRows = await tx
          .select({
            color: workspaces.color,
            createdAt: workspaces.createdAt,
            id: workspaces.id,
            name: workspaces.name,
            roles: sql<(typeof workspaceContacts.$inferSelect.role)[]>`
              array_agg(${workspaceContacts.role})
            `,
            total: sql<number>`(count(*) OVER())::int`,
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
          .limit(LIMITS.workspaceContactsCount);

        return { contact, clientMatterCount, clientMatters, partyMatterRows };
      }),
    );

    const { contact, clientMatterCount, clientMatters, partyMatterRows } =
      reads;

    if (!contact) {
      return Result.err(
        new HandlerError({ status: 404, message: "Contact not found" }),
      );
    }

    return Result.ok({
      ...contact,
      clientMatterCount,
      clientMatters,
      partyMatters: partyMatterRows.map(({ total: _total, ...row }) => row),
      partyCount: partyMatterRows.at(0)?.total ?? 0,
    });
  },
);

export default readContactById;
