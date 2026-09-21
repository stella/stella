import { panic, Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { queryEntities } from "@/api/lib/entities/query-entities";
import { entityQueryWindowBodySchema } from "@/api/lib/entities/query-window-schema";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

const config = {
  description:
    "Read a window of a matter's documents, folders, and tasks with the same " +
    "filters, sorts, search, and field selection as entities.list, plus the " +
    "find filter, but with the page bounds the virtualized table scrolls by " +
    "(200 rows by default). Prefer entities.list unless you are filling a " +
    "table viewport.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_content_across_matters" },
  access: "read",
  body: entityQueryWindowBodySchema,
} satisfies WorkspaceHandlerConfig;

const readEntitiesWindow = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, body, user: currentUser }) {
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
    }

    const limit = body.limit ?? LIMITS.entitiesWindowSizeDefault;
    const result = yield* Result.await(
      queryEntities({
        safeDb,
        scope: { type: "matter", workspaceId },
        currentUserId: currentUser.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: arrayOrEmpty(body.filters),
        sorts: arrayOrEmpty(body.sorts),
        ...(body.search !== undefined && { search: body.search }),
        find: body.find,
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: arrayOrEmpty(body.fieldIds),
        excludedKinds: arrayOrEmpty(body.excludedKinds),
        previewableForAi: body.previewableForAi ?? false,
        includeAssignees: body.includeAssignees ?? false,
      }),
    );

    return Result.ok(
      createCursorPage({
        rows: result.entities,
        limit,
        cursorForItem: (item) =>
          encodeEntitiesWindowCursor(
            result.cursorValuesByEntityId.get(item.entityId) ??
              panic("Missing cursor values for entity window item"),
          ),
      }),
    );
  },
);

export default readEntitiesWindow;
