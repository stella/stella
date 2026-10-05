import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { savedTimeNarratives } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { savedTimeNarrativeParamsSchema } from "./schema";

const config = {
  description:
    "Delete a personal saved time narrative in the active organization.",
  permissions: { timeEntry: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: savedTimeNarrativeParamsSchema,
} satisfies HandlerConfig;

const deleteSavedTimeNarrative = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(savedTimeNarratives)
          .where(
            and(
              eq(savedTimeNarratives.id, params.id),
              eq(
                savedTimeNarratives.organizationId,
                session.activeOrganizationId,
              ),
              eq(savedTimeNarratives.userId, user.id),
            ),
          )
          .returning({ id: savedTimeNarratives.id });
        const row = rows.at(0);
        if (!row) {
          return null;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE,
          resourceId: row.id,
          changes: { deleted: { old: { id: row.id }, new: null } },
        });
        return row;
      }),
    );
    if (!deleted) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Saved time narrative not found",
        }),
      );
    }
    return Result.ok({ id: deleted.id });
  },
);

export default deleteSavedTimeNarrative;
