import { panic, Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { CONTACT_BULK_DELETE_LIMIT, RESOURCE_TYPE } from "@stll/api-contract";

import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";

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

const bulkDeleteContacts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const uniqueIds = [...new Set(body.contactIds)];
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const owned = await readBounded(
          tx
            .select({ id: contacts.id, displayName: contacts.displayName })
            .from(contacts)
            .where(
              and(
                eq(contacts.organizationId, organizationId),
                inArray(contacts.id, uniqueIds),
              ),
            )
            .orderBy(asc(contacts.id)),
          CONTACT_BULK_DELETE_LIMIT,
        );
        // The body schema caps the ids at the same limit, so an overflow
        // means the request contract and this read disagree.
        const ownedContacts =
          owned.type === "complete"
            ? owned.rows
            : panic("Bulk contact delete read more rows than it requested");
        const ownedIds = ownedContacts.map(({ id }) => id);
        const affectedWorkspaces =
          ownedIds.length === 0
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
                    inArray(workspaceContacts.contactId, ownedIds),
                  ),
                );

        const deletedContacts =
          ownedIds.length === 0
            ? []
            : await tx
                .delete(contacts)
                .where(
                  and(
                    eq(contacts.organizationId, organizationId),
                    inArray(contacts.id, ownedIds),
                    sql`NOT EXISTS (
                      SELECT 1
                      FROM ${workspaces}
                      WHERE ${workspaces.organizationId} = ${organizationId}
                        AND ${workspaces.clientId} = ${contacts.id}
                    )`,
                  ),
                )
                .returning({ id: contacts.id });
        const deletedIdSet = new Set(deletedContacts.map(({ id }) => id));
        for (const contact of ownedContacts) {
          if (!deletedIdSet.has(contact.id)) {
            continue;
          }
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
        const affectedWorkspaceIds = affectedWorkspaces
          .filter(({ contactId }) => deletedIdSet.has(contactId))
          .map((row) => row.workspaceId);
        await enqueueWorkspaceSearchRepairs(tx, affectedWorkspaceIds);

        const ownedIdSet = new Set(ownedIds);
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
