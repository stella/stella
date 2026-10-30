import { Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";

export const CONTACT_BULK_DELETE_LIMIT = 500;

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
  mcp: {
    type: "capability",
    reason: "contact_directory",
    consumesServices: false,
  },
  body: bulkDeleteContactsBodySchema,
} satisfies HandlerConfig;

const bulkDeleteContacts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const uniqueIds = [...new Set(body.contactIds)];
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const ownedContacts = await tx
          .select({ id: contacts.id, displayName: contacts.displayName })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              inArray(contacts.id, uniqueIds),
            ),
          )
          .orderBy(asc(contacts.id))
          .limit(CONTACT_BULK_DELETE_LIMIT);
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
        const blockedIds = new Set(clientContacts.map(({ id }) => id));
        const deletableContacts = ownedContacts.filter(
          ({ id }) => !blockedIds.has(id),
        );
        const deletableIds = deletableContacts.map(({ id }) => id);
        const affectedWorkspaces =
          deletableIds.length === 0
            ? []
            : await tx
                .select({ id: workspaceContacts.workspaceId })
                .from(workspaceContacts)
                .where(
                  and(
                    eq(workspaceContacts.organizationId, organizationId),
                    inArray(workspaceContacts.contactId, deletableIds),
                  ),
                );

        if (deletableIds.length > 0) {
          await tx
            .delete(contacts)
            .where(
              and(
                eq(contacts.organizationId, organizationId),
                inArray(contacts.id, deletableIds),
              ),
            );
        }
        for (const contact of deletableContacts) {
          await recordAuditEvent(tx, {
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
          });
        }
        const affectedWorkspaceIds = affectedWorkspaces.map(({ id }) => id);
        await enqueueWorkspaceSearchRepairs(tx, affectedWorkspaceIds);

        const ownedIdSet = new Set(ownedIds);
        const deletedIdSet = new Set(deletableIds);
        return {
          affectedWorkspaceIds,
          outcomes: body.contactIds.map((contactId) => {
            let status: "blocked" | "deleted" | "not_found" = "not_found";
            if (deletedIdSet.has(contactId)) {
              status = "deleted";
            } else if (ownedIdSet.has(contactId)) {
              status = "blocked";
            }
            return { contactId, status };
          }),
        };
      }),
    );

    flushWorkspaceSearchRepairs(txResult.affectedWorkspaceIds).catch(
      createErrorCapture(
        handlerErrorContext("bulkDeleteContacts.flushWorkspaceSearchRepairs"),
      ),
    );
    return Result.ok({ outcomes: txResult.outcomes });
  },
);

export default bulkDeleteContacts;
