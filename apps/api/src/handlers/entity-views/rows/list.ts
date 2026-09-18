import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  ENTITY_VIEW_ROW_KIND,
  ENTITY_VIEW_WORK_RISK,
} from "@stll/api-contract/entity-views";

import {
  inboxEntityCondition,
  inboxSignalCondition,
} from "@/api/handlers/entity-views/rows/inbox-view";
import { listVisibleSignalsByIds } from "@/api/handlers/signals/read";
import { signalViewSchema } from "@/api/handlers/signals/schema";
import { canTriageSignals } from "@/api/handlers/signals/transition";
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
import { entityQueryWindowBodySchema } from "@/api/lib/entities/query-window-schema";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/lib/entities/window-cursor";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import {
  listAtRiskEntityIds,
  resolveWorkAsOf,
} from "@/api/lib/work-obligations/at-risk";

const config = {
  description:
    "Read a table or Kanban window across accessible matters, with the same " +
    "filters, sorts, fields and cursors as a matter view. With `inboxView`, " +
    "the window also holds the caller's Inbox signals for that view, ordered " +
    "by the same sorts under one cursor, and limits tasks to the view's " +
    "lifecycle slice. Task rows carry their governed-work risk as of `asOf`.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_content_across_matters" },
  access: "read",
  body: t.Object({
    ...entityQueryWindowBodySchema.properties,
    scope: t.Union([
      t.Object({ type: t.Literal("organization") }),
      t.Object({ type: t.Literal("matter"), matterId: tSafeId("workspace") }),
    ]),
    inboxView: t.Optional(signalViewSchema),
    asOf: t.Optional(
      t.String({
        format: "date",
        description:
          "The caller's calendar day (YYYY-MM-DD) for work risk; defaults to the server's UTC day",
      }),
    ),
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

const listRows = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    body,
    getWorkspaceAccess,
  }) {
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
    const organizationId = session.activeOrganizationId;
    // One instant for the window and the signal hydration, so a snooze that
    // lapses between the two reads cannot drop a row from the page.
    const now = new Date();
    const signalAccess =
      body.inboxView === undefined
        ? null
        : {
            organizationId,
            canTriage: canTriageSignals(memberRole),
            view: body.inboxView,
            now,
          };
    const result = yield* Result.await(
      queryEntities({
        safeDb,
        scope,
        currentUserId: user.id,
        currentOrganizationId: organizationId,
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
        ...(signalAccess === null
          ? {}
          : {
              entityConditions: [inboxEntityCondition(signalAccess.view)],
              source: {
                type: "entities-and-signals",
                signalConditions: inboxSignalCondition({
                  ...signalAccess,
                  scope,
                }),
              },
            }),
      }),
    );
    const page = createCursorPage({
      rows: result.windowRows,
      limit,
      cursorForItem: (row) => encodeEntitiesWindowCursor(row.cursorValues),
    });
    const pageSignalIds = page.items.flatMap((row) =>
      row.kind === ENTITY_VIEW_ROW_KIND.SIGNAL ? [row.id] : [],
    );
    const pageTaskIds = result.entities.flatMap((entity) =>
      entity.kind === "task" ? [brandPersistedEntityId(entity.entityId)] : [],
    );
    const [signalRowsResult, atRiskIdsResult] = await Promise.all([
      signalAccess === null || pageSignalIds.length === 0
        ? Promise.resolve(Result.ok([]))
        : listVisibleSignalsByIds({
            safeDb,
            access: signalAccess,
            signalIds: pageSignalIds,
          }),
      pageTaskIds.length === 0
        ? Promise.resolve(Result.ok(new Set<string>()))
        : listAtRiskEntityIds({
            safeDb,
            scope,
            entityIds: pageTaskIds,
            asOf: resolveWorkAsOf(body.asOf),
          }),
    ]);
    const signalRows = yield* signalRowsResult;
    const atRiskIds = yield* atRiskIdsResult;
    const entitiesById = new Map(
      result.entities.map((entity) => [entity.entityId, entity]),
    );
    const signalsById = new Map(signalRows.map((row) => [row.id, row]));
    // A row removed between the window read and its hydration drops out; the
    // cursor still points past it, so paging neither repeats nor skips.
    const items = page.items
      .map((row) => {
        switch (row.kind) {
          case ENTITY_VIEW_ROW_KIND.ENTITY: {
            const entity = entitiesById.get(row.id);
            return entity
              ? {
                  kind: ENTITY_VIEW_ROW_KIND.ENTITY,
                  entity,
                  workRisk: atRiskIds.has(row.id)
                    ? ENTITY_VIEW_WORK_RISK.AT_RISK
                    : ENTITY_VIEW_WORK_RISK.NONE,
                }
              : null;
          }
          case ENTITY_VIEW_ROW_KIND.SIGNAL: {
            const signal = signalsById.get(row.id);
            return signal
              ? {
                  kind: ENTITY_VIEW_ROW_KIND.SIGNAL,
                  signal,
                  projection: row.projection,
                }
              : null;
          }
          default: {
            row satisfies never;
            return panic("Unhandled window row kind");
          }
        }
      })
      .filter((item) => item !== null);
    return Result.ok({ ...page, items });
  },
);

export default listRows;
