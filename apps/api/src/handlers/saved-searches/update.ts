import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { SAVED_SEARCH_NOT_FOUND_ERROR_CODE } from "@stll/api-contract";

import { savedSearches } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
import { enforceWritePrecondition } from "@/api/lib/write-contract/write-contract";

import {
  validateSavedSearchCriteria,
  validateSavedSearchName,
  validateSavedSearchWorkspaceAccess,
} from "./criteria";
import { toSavedSearchResponse } from "./response";
import { savedSearchParamsSchema, updateSavedSearchBodySchema } from "./schema";

const config = {
  contract: "replace",
  precondition: {
    type: "updatedAt",
    field: "expectedUpdatedAt",
  },
  permissions: { savedSearch: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "search_ui" },
  params: savedSearchParamsSchema,
  body: updateSavedSearchBodySchema,
  aggregateMutation: {
    type: "aggregate",
    aggregates: ["savedSearch"],
  },
} satisfies HandlerConfig;

type SavedSearchUpdates = {
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

    const updates: SavedSearchUpdates = {};
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
        const acquisition = await withAggregateRowQuery({
          aggregate: "savedSearch",
          id: {
            id: params.savedSearchId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
          },
          tx,
          mode: "update",
          select: (lockTx) => lockTx.select().from(savedSearches),
        });
        const locked = acquisition.rows.at(0);
        if (!locked) {
          return Result.err(
            new HandlerError({
              status: 404,
              code: SAVED_SEARCH_NOT_FOUND_ERROR_CODE,
              message: "Saved search not found",
            }),
          );
        }
        const conflict = enforceWritePrecondition({
          type: "updatedAt",
          field: "expectedUpdatedAt",
          storedUpdatedAt: locked.updatedAt,
          expectedUpdatedAt: body.expectedUpdatedAt,
          resource: "Saved search",
        });
        if (conflict) {
          return Result.err(conflict);
        }
        const [savedSearch] = await tx
          .update(savedSearches)
          .set({
            ...updates,
            // The wire token has millisecond precision; even writes in one
            // clock tick must invalidate the previous editor snapshot.
            updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', ${savedSearches.updatedAt}) + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(savedSearches.id, params.savedSearchId),
              eq(savedSearches.organizationId, session.activeOrganizationId),
              eq(savedSearches.userId, user.id),
            ),
          )
          .returning();
        if (!savedSearch) {
          return panic("Locked saved search disappeared before update");
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_SEARCH,
          resourceId: savedSearch.id,
          changes: { fields: { old: null, new: changedFields } },
        });
        return Result.ok(savedSearch);
      }),
    );
    const savedSearch = yield* updated;
    return Result.ok(toSavedSearchResponse(savedSearch));
  },
);

export default updateSavedSearch;
