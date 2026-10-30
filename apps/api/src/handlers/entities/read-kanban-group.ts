import { panic, Result } from "better-result";
import * as v from "valibot";

import { ENTITY_KINDS } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { tFind } from "@/api/lib/entities/find-schema";
import {
  buildKanbanGroupCondition,
  tGroupByPropertyId,
} from "@/api/lib/entities/kanban-group-condition";
import { queryEntities } from "@/api/lib/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
  ENTITIES_WINDOW_CURSOR_MAX_LENGTH,
} from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readKanbanGroupBodySchema = v.object({
  filters: v.optional(
    v.pipe(v.array(tConditionNode), v.maxLength(LIMITS.viewFiltersCount)),
  ),
  sorts: v.optional(
    v.pipe(v.array(tViewSortSchema), v.maxLength(LIMITS.viewSortsCount)),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.entitiesWindowSizeMax),
    ),
  ),
  cursor: v.optional(
    paginationCursorSchema({ maxChars: ENTITIES_WINDOW_CURSOR_MAX_LENGTH }),
  ),
  find: v.optional(tFind),
  fieldMode: v.optional(v.picklist(["full", "visible"])),
  fieldIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("property")),
      v.maxLength(LIMITS.propertiesCount),
    ),
  ),
  excludedKinds: v.optional(
    v.pipe(
      v.array(v.picklist([...ENTITY_KINDS])),
      v.maxLength(ENTITY_KINDS.length),
    ),
  ),
  groupByPropertyId: tGroupByPropertyId,
  groupValue: v.nullable(v.pipe(v.string(), v.maxLength(1000))),
  optionValues: v.optional(v.array(v.pipe(v.string(), v.maxLength(1000)))),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  access: "read",
  body: readKanbanGroupBodySchema,
} satisfies WorkspaceHandlerConfig;

const readKanbanGroup = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, body, user: currentUser }) {
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
    }

    const conditionResult = buildKanbanGroupCondition({
      groupByPropertyId: body.groupByPropertyId,
      groupValue: body.groupValue,
      optionValues: body.optionValues,
    });
    if (Result.isError(conditionResult)) {
      return Result.err(conditionResult.error);
    }

    const limit = normalizeTenantPageLimit(
      body.limit ?? LIMITS.entitiesWindowSizeDefault,
    );
    const result = yield* Result.await(
      queryEntities({
        textMode: "preview",
        safeDb,
        scope: { type: "matter", workspaceId },
        currentUserId: currentUser.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: arrayOrEmpty(body.filters),
        sorts: arrayOrEmpty(body.sorts),
        find: body.find,
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "visible",
        fieldIds: arrayOrEmpty(body.fieldIds),
        excludedKinds: arrayOrEmpty(body.excludedKinds),
        extraConditions: [conditionResult.value],
      }),
    );

    const page = createCursorPage({
      rows: result.entities,
      limit,
      cursorForItem: (item) =>
        encodeEntitiesWindowCursor(
          result.cursorValuesByEntityId.get(item.entityId) ??
            panic("Missing cursor values for Kanban group item"),
        ),
    });

    return Result.ok(page);
  },
);

export default readKanbanGroup;
