import { panic, Result } from "better-result";
import { t } from "elysia";

import { readEntitiesWindowBodySchema } from "@/api/handlers/entities/read-window";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  buildKanbanGroupCondition,
  tGroupByPropertyId,
} from "@/api/lib/entities/kanban-group-condition";
import { queryEntities } from "@/api/lib/entities/query-entities";
import type { EntityQueryScope } from "@/api/lib/entities/query-scope";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/lib/entities/window-cursor";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

const config = {
  description:
    "Read a table or Kanban window across accessible matters, with the same " +
    "filters, sorts, fields and cursors as a matter view.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_content_across_matters" },
  access: "read",
  body: t.Object({
    ...readEntitiesWindowBodySchema.properties,
    scope: t.Union([
      t.Object({ type: t.Literal("organization") }),
      t.Object({ type: t.Literal("matter"), matterId: tSafeId("workspace") }),
    ]),
    group: t.Optional(
      t.Object({
        groupByPropertyId: tGroupByPropertyId,
        groupValue: t.Nullable(t.String({ maxLength: 1000 })),
        optionValues: t.Optional(
          t.Array(t.String({ maxLength: 1000 }), {
            maxItems: LIMITS.propertiesCount,
          }),
        ),
      }),
    ),
  }),
} satisfies HandlerConfig;

const queryWindow = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, getWorkspaceAccess }) {
    let scope: EntityQueryScope;
    switch (body.scope.type) {
      case "organization":
        scope = {
          type: "organization",
          organizationId: session.activeOrganizationId,
        };
        break;
      case "matter": {
        const { matterId } = body.scope;
        const access = yield* Result.await(
          Result.tryPromise(async () => await getWorkspaceAccess(matterId)),
        );
        if (!access || access.status === "deleting") {
          return Result.err(
            new HandlerError({ status: 404, message: "Matter not found" }),
          );
        }
        scope = { type: "matter", workspaceId: access.id };
        break;
      }
      default: {
        body.scope satisfies never;
        return panic(`Unhandled view scope: ${String(body.scope)}`);
      }
    }
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
    }
    const groupCondition = body.group
      ? buildKanbanGroupCondition({
          groupByPropertyId: body.group.groupByPropertyId,
          groupValue: body.group.groupValue,
          optionValues: body.group.optionValues,
        })
      : Result.ok(undefined);
    if (Result.isError(groupCondition)) {
      return Result.err(groupCondition.error);
    }
    const limit = body.limit ?? LIMITS.entitiesWindowSizeDefault;
    const result = yield* Result.await(
      queryEntities({
        safeDb,
        scope,
        currentUserId: user.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: arrayOrEmpty(body.filters),
        sorts: arrayOrEmpty(body.sorts),
        search: body.search,
        find: body.find,
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: arrayOrEmpty(body.fieldIds),
        excludedKinds: arrayOrEmpty(body.excludedKinds),
        previewableForAi: body.previewableForAi ?? false,
        includeAssignees: body.includeAssignees ?? false,
        extraConditions: groupCondition.value ? [groupCondition.value] : [],
      }),
    );
    return Result.ok(
      createCursorPage({
        rows: result.entities,
        limit,
        cursorForItem: (item) =>
          encodeEntitiesWindowCursor(
            result.cursorValuesByEntityId.get(item.entityId) ??
              panic("Missing entity view cursor"),
          ),
      }),
    );
  },
);

export default queryWindow;
