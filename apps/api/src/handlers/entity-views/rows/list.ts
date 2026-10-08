import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  ENTITY_VIEW_ROW_KIND,
  ENTITY_VIEW_WORK_RISK,
} from "@stll/api-contract/entity-views";

import {
  inboxEntityCondition,
  inboxSignalCondition,
  SIGNAL_INBOX_FEATURE_ACCESS,
} from "@/api/handlers/entity-views/rows/inbox-view";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
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
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import {
  canTriageSignals,
  listVisibleSignalsByIds,
} from "@/api/lib/signals/read";
import { signalViewSchema } from "@/api/lib/signals/view-schema";
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
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: SIGNAL_INBOX_FEATURE_ACCESS,
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
          "The caller's calendar day (YYYY-MM-DD) for work risk; defaults to the organization's day in its time zone",
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
    if (
      body.inboxView !== undefined &&
      !isDeploymentFeatureEnabled("FEATURE_SIGNALS")
    ) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }
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
    const limit = normalizeTenantPageLimit(
      body.limit ?? LIMITS.entitiesWindowSizeDefault,
    );
    const organizationId = session.activeOrganizationId;
    const asOf = yield* Result.await(
      resolveWorkAsOf({ asOf: body.asOf, safeDb, organizationId }),
    );
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
            asOf,
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
