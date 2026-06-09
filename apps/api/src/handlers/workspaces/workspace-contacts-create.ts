import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

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
  contactId: tSafeId("contact"),
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
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    const txResult = await safeDb(async (tx) => {
      const contact = await tx.query.contacts.findFirst({
        where: {
          id: { eq: body.contactId },
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

      if (created) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
          resourceId: created.id,
          changes: {
            created: {
              old: null,
              new: {
                contactId: created.contactId,
                role: created.role,
                isPrimary: created.isPrimary,
              },
            },
          },
        });
      }

      return { ok: true as const, created };
    });

    if (Result.isError(txResult)) {
      if (
        DatabaseError.is(txResult.error) &&
        txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(
          new HandlerError({
            status: 409,
            message: "Contact already has this role on the matter",
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

    upsertWorkspaceSearchDocument(workspaceId).catch(captureError);

    const created = txResult.value.created;
    if (!created) {
      panic("Failed to create workspace contact");
    }

    return Result.ok(created);
  },
);

export default createWorkspaceContact;
