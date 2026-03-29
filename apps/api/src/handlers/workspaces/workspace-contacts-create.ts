import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const WORKSPACE_CONTACT_ROLES = [
  "opposing_party",
  "opposing_counsel",
  "co_counsel",
  "witness",
  "expert_witness",
  "third_party",
  "judge",
  "mediator",
  "other",
] as const;

const createWorkspaceContactBodySchema = t.Object({
  contactId: tNanoid,
  role: t.UnionEnum(WORKSPACE_CONTACT_ROLES),
  isPrimary: t.Optional(t.Boolean()),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const config = {
  permissions: { workspace: ["update"] },
  body: createWorkspaceContactBodySchema,
} satisfies HandlerConfig;

const createWorkspaceContact = createHandler(
  config,
  async ({ scopedDb, session, workspaceId, body }) =>
    await scopedDb(async (tx) => {
      const contact = await tx.query.contacts.findFirst({
        where: {
          id: body.contactId,
          organizationId: { eq: session.activeOrganizationId },
        },
        columns: { id: true },
      });

      if (!contact) {
        return status(400, {
          message: "Contact not found",
        });
      }

      // Lock rows then count to serialize concurrent adds.
      // PG rejects FOR UPDATE with aggregate functions.
      const lockedRows = await tx
        .select({ id: workspaceContacts.id })
        .from(workspaceContacts)
        .where(eq(workspaceContacts.workspaceId, workspaceId))
        .for("update");

      if (lockedRows.length >= LIMITS.workspaceContactsCount) {
        return status(400, {
          message: "Workspace contacts limit reached",
        });
      }

      const result = await Result.tryPromise({
        try: () =>
          tx
            .insert(workspaceContacts)
            .values({
              organizationId: session.activeOrganizationId,
              workspaceId,
              contactId: body.contactId,
              role: body.role,
              isPrimary: body.isPrimary ?? false,
              notes: body.notes ?? null,
            })
            .returning(),
        catch: (error) => error,
      });

      if (result.isErr()) {
        if (isPgError(result.error, PG_ERROR.UNIQUE_VIOLATION)) {
          return status(409, {
            message: "Contact already has this role on the matter",
          });
        }
        throw result.error;
      }

      const [created] = result.value;
      return created;
    }),
);

export default createWorkspaceContact;
