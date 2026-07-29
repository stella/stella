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
  validateSavedSearchWorkspaceAccess,
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
  async function* ({
    body,
    getActiveWorkspaceIds,
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
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
    let criteria: SavedSearchCriteria | undefined;
    if (body.criteria !== undefined) {
      const parsedCriteria = validateSavedSearchCriteria(body.criteria);
      if (Result.isError(parsedCriteria)) {
        return Result.err(parsedCriteria.error);
      }
      criteria = parsedCriteria.value;
      if (parsedCriteria.value.workspaceIds.length > 0) {
        const activeWorkspaceIds = yield* Result.await(
          Result.tryPromise(async () => await getActiveWorkspaceIds()),
        );
        const accessValidation = validateSavedSearchWorkspaceAccess(
          parsedCriteria.value,
          activeWorkspaceIds,
        );
        if (Result.isError(accessValidation)) {
          return Result.err(accessValidation.error);
        }
        criteria = accessValidation.value;
      }
    }

    const updates: SavedSearchUpdates = { updatedAt: new Date() };
    const changedFields: string[] = [];
    if (name && Result.isOk(name)) {
      updates.name = name.value;
      changedFields.push("name");
    }
    if (criteria) {
      updates.criteria = criteria;
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
