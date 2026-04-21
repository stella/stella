import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  contactId: tUuid,
  role: t.UnionEnum(WORKSPACE_CONTACT_ROLES),
  isPrimary: t.Optional(t.Boolean()),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const config = {
  permissions: { workspace: ["update"] },
  body: createWorkspaceContactBodySchema,
} satisfies HandlerConfig;

const createWorkspaceContact = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body }) {
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const contact = await tx.query.contacts.findFirst({
          where: {
            id: body.contactId,
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { id: true },
        });

        if (!contact) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Contact not found",
          };
        }

        // Lock rows then count to serialize concurrent adds.
        // PG rejects FOR UPDATE with aggregate functions.
        const lockedRows = await tx
          .select({ id: workspaceContacts.id })
          .from(workspaceContacts)
          .where(eq(workspaceContacts.workspaceId, workspaceId))
          .for("update");

        if (lockedRows.length >= LIMITS.workspaceContactsCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Workspace contacts limit reached",
          };
        }

        try {
          const [created] = await tx
            .insert(workspaceContacts)
            .values({
              organizationId: session.activeOrganizationId,
              workspaceId,
              contactId: body.contactId,
              role: body.role,
              isPrimary: body.isPrimary ?? false,
              notes: body.notes ?? null,
            })
            .returning();

          return { ok: true as const, created };
        } catch (error) {
          if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
            return {
              ok: false as const,
              status: 409 as const,
              message: "Contact already has this role on the matter",
            };
          }
          throw error;
        }
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

    return Result.ok(txResult.created);
  },
);

export default createWorkspaceContact;
