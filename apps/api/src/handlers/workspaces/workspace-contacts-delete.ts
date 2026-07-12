import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { workspaceContacts } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "covered", by: "link_matter_contact" },
  params: workspaceParams({ workspaceContactId: tSafeId("workspaceContact") }),
} satisfies HandlerConfig;

export type DeleteWorkspaceContactHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  workspaceContactId: SafeId<"workspaceContact">;
  recordAuditEvent: AuditRecorder;
};

// Shared matter-contact unlink logic reused by the HTTP handler and the
// `link_matter_contact` MCP tool, so both emit identical audit events
// and search-index writes.
export const deleteWorkspaceContactHandler = async function* ({
  safeDb,
  workspaceId,
  workspaceContactId,
  recordAuditEvent,
}: DeleteWorkspaceContactHandlerProps) {
  const deletedRows = yield* Result.await(
    safeDb(async (tx) => {
      const rows = await tx
        .delete(workspaceContacts)
        .where(
          and(
            eq(workspaceContacts.id, workspaceContactId),
            eq(workspaceContacts.workspaceId, workspaceId),
          ),
        )
        .returning({
          id: workspaceContacts.id,
          contactId: workspaceContacts.contactId,
          role: workspaceContacts.role,
        });

      const deletedRow = rows.at(0);
      if (deletedRow) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
          resourceId: workspaceContactId,
          changes: {
            deleted: {
              old: {
                contactId: deletedRow.contactId,
                role: deletedRow.role,
              },
              new: null,
            },
          },
        });
      }

      return rows;
    }),
  );
  const deleted = deletedRows.at(0);

  if (!deleted) {
    return Result.err(
      new HandlerError({ status: 404, message: "Party not found" }),
    );
  }

  upsertWorkspaceSearchDocument(workspaceId).catch(captureError);

  return Result.ok({ id: deleted.id });
};

const deleteWorkspaceContact = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params: { workspaceContactId },
    recordAuditEvent,
  }) {
    return yield* deleteWorkspaceContactHandler({
      safeDb,
      workspaceId,
      workspaceContactId,
      recordAuditEvent,
    });
  },
);

export default deleteWorkspaceContact;
