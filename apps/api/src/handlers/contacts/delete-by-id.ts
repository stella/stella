import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const deleteContactParamsSchema = t.Object({
  contactId: tNanoid,
});

const deleteContactById = createSafeRootHandler(
  {
    permissions: { contact: ["delete"] },
    params: deleteContactParamsSchema,
  },
  async function* ({ safeDb, session, params }) {
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
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

        const matterCount = await tx.$count(
          workspaces,
          and(
            eq(workspaces.clientId, params.contactId),
            eq(workspaces.organizationId, session.activeOrganizationId),
          ),
        );

        if (matterCount > 0) {
          return {
            ok: false as const,
            status: 409 as const,
            message: `Reassign or delete ${matterCount} matter${
              matterCount === 1 ? "" : "s"
            } before deleting this contact`,
          };
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
            return {
              ok: false as const,
              status: 409 as const,
              message:
                "Reassign or delete matters before deleting this contact",
            };
          }
          throw error;
        }

        return { ok: true as const };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok(undefined);
  },
);

export default deleteContactById;
