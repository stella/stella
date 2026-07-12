import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { upsertWorkspaceSearchDocuments } from "@/api/lib/search/index-global";

const deleteContactParamsSchema = t.Object({
  contactId: tSafeId("contact"),
});

export type DeleteContactHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
  recordAuditEvent: AuditRecorder;
};

// Shared contact-delete logic reused by the HTTP handler and the
// `delete_contact` MCP tool, so both emit identical audit events and
// search-index writes.
export const deleteContactHandler = async function* ({
  safeDb,
  organizationId,
  contactId,
  recordAuditEvent,
}: DeleteContactHandlerProps) {
  const txResult = await safeDb(async (tx) => {
    const contact = await tx
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
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
        eq(workspaces.clientId, contactId),
        eq(workspaces.organizationId, organizationId),
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

    // oxlint-disable-next-line react-doctor/async-parallel -- sequential by design: same DB transaction client (tx)
    const affectedWorkspaces = await tx
      .select({ id: workspaceContacts.workspaceId })
      .from(workspaceContacts)
      .where(
        and(
          eq(workspaceContacts.contactId, contactId),
          eq(workspaceContacts.organizationId, organizationId),
        ),
      );

    await tx
      .delete(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
        ),
      );

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contactId,
      workspaceId: null,
      changes: {
        deleted: {
          old: { displayName: contact.displayName },
          new: null,
        },
      },
    });

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

  return Result.ok({});
};

const deleteContactById = createSafeRootHandler(
  {
    permissions: { contact: ["delete"] },
    mcp: { type: "tool", name: "delete_contact" },
    params: deleteContactParamsSchema,
  },
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    return yield* deleteContactHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      contactId: params.contactId,
      recordAuditEvent,
    });
  },
);

export default deleteContactById;
