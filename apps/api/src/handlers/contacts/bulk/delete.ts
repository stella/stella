import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { CONTACT_BULK_DELETE_LIMIT, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { lockContactCapacity } from "@/api/handlers/contacts/contact-capacity";
import { createErrorCapture, detached } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { lockOwnedContactsForBulkDelete } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { announceContactSetChanged } from "@/api/lib/resource-realtime";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import {
  holdsBlocking,
  lockLegalHoldOrganization,
} from "@/api/lib/workspaces/legal-holds/holds";

export { CONTACT_BULK_DELETE_LIMIT } from "@stll/api-contract";

export const bulkDeleteContactsBodySchema = v.strictObject({
  contactIds: v.pipe(
    v.array(resourceIdSchema("contact")),
    v.minLength(1),
    v.maxLength(CONTACT_BULK_DELETE_LIMIT),
  ),
});

const config = {
  contract: "patch",
  description:
    "Permanently delete up to 500 contacts from the organization address book in one transaction. Contacts used as matter clients are skipped.",
  permissions: { contact: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.CONTACT),
  mcp: {
    type: "capability",
    reason: "contact_directory",
    consumesServices: false,
  },
  body: bulkDeleteContactsBodySchema,
} satisfies HandlerConfig;

type BulkDeleteContactsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  contactIds: readonly SafeId<"contact">[];
  recordAuditEvent: AuditRecorder;
};

/** Delete the owned, unblocked contacts in the caller's transaction. */
export const bulkDeleteContactsInTransaction = async ({
  tx,
  organizationId,
  contactIds,
  recordAuditEvent,
}: BulkDeleteContactsOptions) => {
  const uniqueIds = [...new Set(contactIds)];
  // The hold fence comes before the contact rows, as in single deletion.
  await lockLegalHoldOrganization({ tx, organizationId, mode: "update" });
  await lockContactCapacity(tx, organizationId);
  const owned = await lockOwnedContactsForBulkDelete({
    tx,
    organizationId,
    contactIds: uniqueIds,
    cap: CONTACT_BULK_DELETE_LIMIT,
  });
  // The body schema caps the ids at the same limit, so an overflow
  // means the request contract and this read disagree.
  const ownedContacts =
    owned.type === "complete"
      ? owned.rows
      : panic("Bulk contact delete read more rows than it requested");
  const ownedIds = ownedContacts.map(({ id }) => id);
  const clientContacts =
    ownedIds.length === 0
      ? []
      : await tx
          .select({ id: workspaces.clientId })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.organizationId, organizationId),
              inArray(workspaces.clientId, ownedIds),
            ),
          );
  const blockedIdSet = new Set(clientContacts.map(({ id }) => id));
  const unblockedIds = ownedIds.filter((id) => !blockedIdSet.has(id));
  const linkedWorkspaces =
    unblockedIds.length === 0
      ? []
      : await tx
          .select({
            contactId: workspaceContacts.contactId,
            workspaceId: workspaceContacts.workspaceId,
          })
          .from(workspaceContacts)
          .where(
            and(
              eq(workspaceContacts.organizationId, organizationId),
              inArray(workspaceContacts.contactId, unblockedIds),
            ),
          );
  // A contact linked to a held matter stays, reported as blocked like a
  // matter client; the others are deleted.
  const holds =
    unblockedIds.length === 0
      ? ({ type: "clear" } as const)
      : await holdsBlocking({
          tx,
          organizationId,
          target: { type: "contactIds", ids: unblockedIds },
        });
  const heldWorkspaceIds = new Set<string>(
    holds.type === "held" ? holds.holds.map((hold) => hold.workspaceId) : [],
  );
  for (const { contactId, workspaceId } of linkedWorkspaces) {
    if (heldWorkspaceIds.has(workspaceId)) {
      blockedIdSet.add(contactId);
    }
  }
  const deletableIds = unblockedIds.filter((id) => !blockedIdSet.has(id));
  const affectedWorkspaces = linkedWorkspaces.filter(({ contactId }) =>
    deletableIds.includes(contactId),
  );

  const deletedContacts =
    deletableIds.length === 0
      ? []
      : await tx
          .delete(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              inArray(contacts.id, deletableIds),
            ),
          )
          .returning({ id: contacts.id });
  const deletedIdSet = new Set(deletedContacts.map(({ id }) => id));
  const auditEvents = ownedContacts
    .filter((contact) => deletedIdSet.has(contact.id))
    .map((contact): AuditEvent => ({
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contact.id,
      workspaceId: null,
      changes: {
        deleted: {
          old: { displayName: contact.displayName },
          new: null,
        },
      },
    }));
  if (auditEvents.length > 0) {
    await recordAuditEvent(tx, auditEvents);
  }
  const affectedWorkspaceIds = affectedWorkspaces
    .filter(({ contactId }) => deletedIdSet.has(contactId))
    .map((row) => row.workspaceId);
  await enqueueWorkspaceSearchRepairs(tx, affectedWorkspaceIds);

  return {
    affectedWorkspaceIds,
    outcomes: contactIds.map((contactId) => {
      let status: "blocked" | "deleted" | "not_found" = "not_found";
      if (deletedIdSet.has(contactId)) {
        status = "deleted";
      } else if (blockedIdSet.has(contactId)) {
        status = "blocked";
      }
      return { contactId, status };
    }),
  };
};

const bulkDeleteContacts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const txResult = yield* Result.await(
      safeDb(
        async (tx) =>
          await bulkDeleteContactsInTransaction({
            tx,
            organizationId,
            contactIds: body.contactIds,
            recordAuditEvent,
          }),
      ),
    );

    detached(
      async () =>
        flushWorkspaceSearchRepairs(txResult.affectedWorkspaceIds).catch(
          createErrorCapture(
            handlerErrorContext(
              "bulkDeleteContacts.flushWorkspaceSearchRepairs",
            ),
          ),
        ),
      "contacts-bulk-delete.flush-workspace-search-repairs",
    );
    if (txResult.outcomes.some(({ status }) => status === "deleted")) {
      announceContactSetChanged(organizationId);
    }
    return Result.ok({ outcomes: txResult.outcomes });
  },
);

declareAggregateMutation(bulkDeleteContacts, {
  type: "aggregate",
  aggregates: ["contactCapacity"],
});

export default bulkDeleteContacts;
