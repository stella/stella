import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { upsertWorkspaceSearchDocuments } from "@/api/lib/search/index-global";

const deleteContactParamsSchema = t.Object({
  contactId: tSafeId("contact"),
});

const deleteContactById = createSafeRootHandler(
  {
    permissions: { contact: ["delete"] },
    params: deleteContactParamsSchema,
  },
  async function* ({ safeDb, session, params }) {
    const txResult = await safeDb(async (tx) => {
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
        return {
          ok: false as const,
          status: 404 as const,
          message: "Contact not found",
        };
      }

      const clientMatterCount = await tx.$count(
        workspaces,
        and(
          eq(workspaces.clientId, params.contactId),
          eq(workspaces.organizationId, session.activeOrganizationId),
        ),
      );

      if (clientMatterCount > 0) {
        return {
          ok: false as const,
          status: 409 as const,
          message: `Reassign or delete ${clientMatterCount} matter${
            clientMatterCount === 1 ? "" : "s"
          } before deleting this contact`,
        };
      }

      const affectedWorkspaces = await tx
        .select({ id: workspaceContacts.workspaceId })
        .from(workspaceContacts)
        .where(
          and(
            eq(workspaceContacts.contactId, params.contactId),
            eq(workspaceContacts.organizationId, session.activeOrganizationId),
          ),
        );

      await tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.id, params.contactId),
            eq(contacts.organizationId, session.activeOrganizationId),
          ),
        );

      return {
        ok: true as const,
        affectedWorkspaceIds: affectedWorkspaces.map(({ id }) => id),
      };
    });

    if (Result.isError(txResult)) {
      if (
        DatabaseError.is(txResult.error) &&
        txResult.error.code === PG_ERROR.FOREIGN_KEY_VIOLATION
      ) {
        return yield* Result.err(
          new HandlerError({
            status: 409,
            message: "Reassign or delete matters before deleting this contact",
          }),
        );
      }
      return yield* Result.err(txResult.error);
    }

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: txResult.value.status,
          message: txResult.value.message,
        }),
      );
    }

    upsertWorkspaceSearchDocuments(txResult.value.affectedWorkspaceIds).catch(
      captureError,
    );

    return Result.ok(undefined);
  },
);

export default deleteContactById;
