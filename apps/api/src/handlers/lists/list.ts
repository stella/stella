import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { LEGAL_LIST_STATUSES, legalLists } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegalListId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";

const querySchema = v.object({
  limit: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.legalListsPageSizeMax),
      ),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
  status: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
});

const config = {
  contract: "patch",
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "List a matter's lists, newest first, with cursor pagination, filtered " +
    "by status (active by default, archived on request). Each entry carries " +
    "the name, description, status, and timestamps.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  query: querySchema,
} satisfies WorkspaceHandlerConfig;

const listCursorCodec = createTimestampIdCursorCodec({
  column: legalLists.createdAt,
  brandId: brandPersistedLegalListId,
});

const readLists = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.legalListsPageSizeDefault,
    );
    const status = query.status ?? "active";
    if (!includes(LEGAL_LIST_STATUSES, status)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid List status" }),
      );
    }

    const conditions = [
      eq(legalLists.workspaceId, workspaceId),
      eq(legalLists.status, status),
    ];

    if (query.cursor) {
      const cursor = listCursorCodec.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = listCursorCodec.keysetAfter({
        cursor,
        direction: "descending",
        idColumn: legalLists.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: legalLists.id,
            name: legalLists.name,
            description: legalLists.description,
            status: legalLists.status,
            createdAt: legalLists.createdAt,
            updatedAt: legalLists.updatedAt,
            createdAtCursor:
              listCursorCodec.cursorValue.as("created_at_cursor"),
          })
          .from(legalLists)
          .where(and(...conditions))
          .orderBy(desc(legalLists.createdAt), desc(legalLists.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        listCursorCodec.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(
        ({ createdAtCursor: _createdAtCursor, ...item }) => item,
      ),
    });
  },
);

export default readLists;
