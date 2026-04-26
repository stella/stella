import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    clientId: t.Optional(tSafeId("contact")),
    reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
    billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  }),
} satisfies HandlerConfig;

// Workspace name is fetched via JOIN at search time;
// no reindex needed on rename.
const updateWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body }) {
    const txResult = await safeDb(async (tx) => {
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
          return {
            ok: false as const,
            status: 404 as const,
            message: "Client not found",
          };
        }
      }

      await tx
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
      return { ok: true as const };
    });

    if (Result.isError(txResult)) {
      if (
        DatabaseError.is(txResult.error) &&
        txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(
          new HandlerError({ status: 409, message: "Duplicate value" }),
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

    return Result.ok(undefined);
  },
);

export default updateWorkspace;
