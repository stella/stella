import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { savedSearches } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { savedSearchParamsSchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: savedSearchParamsSchema,
} satisfies HandlerConfig;

const deleteSavedSearch = createSafeRootHandler(
  config,
  async function* ({ params, recordAuditEvent, safeDb, session, user }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const [savedSearch] = await tx
          .delete(savedSearches)
          .where(
            and(
              eq(savedSearches.id, params.savedSearchId),
              eq(savedSearches.organizationId, session.activeOrganizationId),
              eq(savedSearches.userId, user.id),
            ),
          )
          .returning({ id: savedSearches.id });
        if (!savedSearch) {
          return null;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_SEARCH,
          resourceId: savedSearch.id,
          changes: { deleted: { old: null, new: null } },
        });
        return savedSearch;
      }),
    );
    if (!deleted) {
      return Result.err(
        new HandlerError({ status: 404, message: "Saved search not found" }),
      );
    }

    return Result.ok({});
  },
);

export default deleteSavedSearch;
