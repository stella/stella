import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { caseLawResearchTables } from "@/api/db/schema";
import {
  researchTableListQuerySchema,
  toResearchTableResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedCaseLawResearchTableId } from "@/api/lib/safe-id-boundaries";

const config = {
  description:
    "List the organization's case-law research tables, most recently " +
    "updated first.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  query: researchTableListQuerySchema,
} satisfies HandlerConfig;

export const researchTableCursor = createTimestampIdCursorCodec({
  column: caseLawResearchTables.updatedAt,
  brandId: brandPersistedCaseLawResearchTableId,
});

const listResearchTables = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = query.limit ?? LIMITS.caseLawResearchTablesPageSizeDefault;
    const conditions = [
      eq(caseLawResearchTables.organizationId, session.activeOrganizationId),
    ];
    if (query.cursor) {
      const cursor = researchTableCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = researchTableCursor.keysetAfter({
        cursor,
        idColumn: caseLawResearchTables.id,
        direction: "descending",
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: caseLawResearchTables.id,
            organizationId: caseLawResearchTables.organizationId,
            ownerUserId: caseLawResearchTables.ownerUserId,
            name: caseLawResearchTables.name,
            savedQuery: caseLawResearchTables.savedQuery,
            createdAt: caseLawResearchTables.createdAt,
            updatedAt: caseLawResearchTables.updatedAt,
            updatedAtCursor:
              researchTableCursor.cursorValue.as("updated_at_cursor"),
          })
          .from(caseLawResearchTables)
          .where(and(...conditions))
          .orderBy(
            desc(caseLawResearchTables.updatedAt),
            desc(caseLawResearchTables.id),
          )
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        researchTableCursor.encode(item.updatedAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(toResearchTableResponse),
    });
  },
);

export default listResearchTables;
