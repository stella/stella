import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { savedSearches } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  validateSavedSearchCriteria,
  validateSavedSearchName,
  validateSavedSearchWorkspaceAccess,
} from "./criteria";
import { toSavedSearchResponse } from "./response";
import { createSavedSearchBodySchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: createSavedSearchBodySchema,
} satisfies HandlerConfig;

const createSavedSearch = createSafeRootHandler(
  config,
  async function* ({
    body,
    getActiveWorkspaceIds,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const name = validateSavedSearchName(body.name);
    if (Result.isError(name)) {
      return Result.err(name.error);
    }
    const criteria = validateSavedSearchCriteria(body.criteria);
    if (Result.isError(criteria)) {
      return Result.err(criteria.error);
    }
    let accessibleCriteria = criteria.value;
    if (criteria.value.workspaceIds.length > 0) {
      const activeWorkspaceIds = yield* Result.await(
        Result.tryPromise(async () => await getActiveWorkspaceIds()),
      );
      const accessValidation = validateSavedSearchWorkspaceAccess(
        criteria.value,
        activeWorkspaceIds,
      );
      if (Result.isError(accessValidation)) {
        return Result.err(accessValidation.error);
      }
      accessibleCriteria = accessValidation.value;
    }

    const created = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize the count-and-insert pair so concurrent browser tabs cannot
        // bypass the per-user cap.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );
        const count = await tx.$count(
          savedSearches,
          and(
            eq(savedSearches.organizationId, session.activeOrganizationId),
            eq(savedSearches.userId, user.id),
          ),
        );
        if (count >= LIMITS.savedSearchesPerUser) {
          return null;
        }

        const [savedSearch] = await tx
          .insert(savedSearches)
          .values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            name: name.value,
            criteria: accessibleCriteria,
          })
          .returning();
        if (!savedSearch) {
          return null;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_SEARCH,
          resourceId: savedSearch.id,
          changes: {
            created: {
              old: null,
              new: { criteriaVersion: accessibleCriteria.version },
            },
          },
        });
        return savedSearch;
      }),
    );
    if (!created) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Saved search limit reached",
        }),
      );
    }

    return Result.ok(toSavedSearchResponse(created));
  },
);

export default createSavedSearch;
