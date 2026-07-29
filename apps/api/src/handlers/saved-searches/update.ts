import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { savedSearches } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";

import {
  validateSavedSearchCriteria,
  validateSavedSearchName,
} from "./criteria";
import { toSavedSearchResponse } from "./response";
import { savedSearchParamsSchema, updateSavedSearchBodySchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: savedSearchParamsSchema,
  body: updateSavedSearchBodySchema,
} satisfies HandlerConfig;

type SavedSearchUpdates = {
  updatedAt: Date;
  name?: string;
  criteria?: SavedSearchCriteria;
};

const updateSavedSearch = createSafeRootHandler(
  config,
  async function* ({ body, params, recordAuditEvent, safeDb, session, user }) {
    if (body.name === undefined && body.criteria === undefined) {
      return Result.err(
        new HandlerError({ status: 422, message: "No saved search changes" }),
      );
    }

    const name =
      body.name === undefined ? undefined : validateSavedSearchName(body.name);
    if (name && Result.isError(name)) {
      return Result.err(name.error);
    }
    const criteria =
      body.criteria === undefined
        ? undefined
        : validateSavedSearchCriteria(body.criteria);
    if (criteria && Result.isError(criteria)) {
      return Result.err(criteria.error);
    }

    const updates: SavedSearchUpdates = { updatedAt: new Date() };
    const changedFields: string[] = [];
    if (name && Result.isOk(name)) {
      updates.name = name.value;
      changedFields.push("name");
    }
    if (criteria && Result.isOk(criteria)) {
      updates.criteria = criteria.value;
      changedFields.push("criteria");
    }

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const [savedSearch] = await tx
          .update(savedSearches)
          .set(updates)
          .where(
            and(
              eq(savedSearches.id, params.savedSearchId),
              eq(savedSearches.organizationId, session.activeOrganizationId),
              eq(savedSearches.userId, user.id),
            ),
          )
          .returning();
        if (!savedSearch) {
          return null;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_SEARCH,
          resourceId: savedSearch.id,
          changes: { fields: { old: null, new: changedFields } },
        });
        return savedSearch;
      }),
    );
    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Saved search not found" }),
      );
    }

    return Result.ok(toSavedSearchResponse(updated));
  },
);

export default updateSavedSearch;
