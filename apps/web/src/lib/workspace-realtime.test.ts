import { hashKey, QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";

import { fileContentByFieldQueryRoot } from "@/lib/files/file-metadata-query.logic";
import {
  contactsQueryRoot,
  workspaceMembersQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

import {
  getWorkspaceRealtimeQueryActions,
  getWorkspaceReconnectQueryActions,
  isWorkspaceQueryKey,
  parseWorkspaceRealtimeMessage,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "./workspace-realtime";

const WORKSPACE_ID = "workspace-1";

const parseEvent = (value: unknown) =>
  parseWorkspaceRealtimeMessage(JSON.stringify(value));

describe("workspace realtime policy", () => {
  test("maps entity updates and deletions without producer-owned query keys", () => {
    const updated = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-1" },
    });
    const deleted = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-1" },
    });

    expect(updated).not.toBeNull();
    expect(deleted).not.toBeNull();
    if (!(updated && deleted)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(updated, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["tasks", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "overview"],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(deleted, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
        queryKey: ["entities", WORKSPACE_ID, "entity-1"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["tasks", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "overview"],
      },
    ]);
  });

  test("maps view changes and explicitly ignores resources without a policy", () => {
    const view = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.WORKSPACE_VIEW, id: "view-1" },
    });
    const memory = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.AI_MEMORY, id: "memory-1" },
    });

    expect(view).not.toBeNull();
    expect(memory).not.toBeNull();
    if (!(view && memory)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(view, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["views", WORKSPACE_ID],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(memory, WORKSPACE_ID)).toEqual([]);
  });

  test("maps field changes to entity and field-file caches", () => {
    const updated = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.FIELD, id: "field-1" },
    });
    const deleted = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
      resource: { type: RESOURCE_TYPE.FIELD, id: "field-1" },
    });

    expect(updated).not.toBeNull();
    expect(deleted).not.toBeNull();
    if (!(updated && deleted)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(updated, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["files", WORKSPACE_ID, "field-1"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["files", "metadata", WORKSPACE_ID, "field-1"],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(deleted, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
        queryKey: ["files", WORKSPACE_ID, "field-1"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
        queryKey: ["files", "metadata", WORKSPACE_ID, "field-1"],
      },
    ]);
  });

  test("deduplicates cache actions from bounded resource batches", () => {
    const event = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
      changes: [
        {
          change: "updated",
          resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-1" },
        },
        {
          change: "updated",
          resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-2" },
        },
        {
          change: "updated",
          resource: { type: RESOURCE_TYPE.FIELD, id: "field-1" },
        },
      ],
    });

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["tasks", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "overview"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["files", WORKSPACE_ID, "field-1"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["files", "metadata", WORKSPACE_ID, "field-1"],
      },
    ]);
  });

  test("maps whole-resource-set changes without synthetic resource ids", () => {
    const entitySet = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
      resourceType: RESOURCE_TYPE.ENTITY,
    });
    const flowRunSet = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
      resourceType: RESOURCE_TYPE.FLOW_RUN,
    });

    expect(entitySet).not.toBeNull();
    expect(flowRunSet).not.toBeNull();
    if (!(entitySet && flowRunSet)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(entitySet, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["tasks", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "overview"],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(flowRunSet, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["flow-runs", WORKSPACE_ID],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "workflow"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["workspaces", WORKSPACE_ID, "justifications"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
    ]);
  });

  test("maps every migrated resource domain to a server-owned query root", () => {
    const cases = [
      [RESOURCE_TYPE.AGENT_SKILL, ["skills"]],
      [RESOURCE_TYPE.BILLING_CODE, ["billingCodes", WORKSPACE_ID]],
      [RESOURCE_TYPE.CONTACT, ["contacts"]],
      [RESOURCE_TYPE.EXPENSE, ["expenses", WORKSPACE_ID]],
      [RESOURCE_TYPE.INVOICE, ["invoices", WORKSPACE_ID]],
      [RESOURCE_TYPE.LEGAL_LIST, ["legal-lists", WORKSPACE_ID]],
      [RESOURCE_TYPE.MCP_CONNECTOR, ["mcp"]],
      [RESOURCE_TYPE.ORGANIZATION, ["organization"]],
      [RESOURCE_TYPE.PROPERTY, ["properties", WORKSPACE_ID]],
      [RESOURCE_TYPE.RATE_TABLE, ["rates", WORKSPACE_ID]],
      [RESOURCE_TYPE.TIME_ENTRY, ["timeEntries", WORKSPACE_ID]],
      [RESOURCE_TYPE.WORKSPACE, ["workspaces"]],
    ] as const;

    for (const [resourceType, expectedQueryKey] of cases) {
      const event = parseEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
        resourceType,
      });
      expect(event).not.toBeNull();
      if (!event) {
        continue;
      }
      expect(
        getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID),
      ).toContainEqual({
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: expectedQueryKey,
      });
    }
  });

  test("rejects malformed JSON, unknown events, and malformed resources", () => {
    expect(parseWorkspaceRealtimeMessage("not-json")).toBeNull();
    expect(parseEvent({ type: "unknown", data: null })).toBeNull();
    expect(
      parseEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
        resource: { type: RESOURCE_TYPE.ENTITY, id: "" },
      }),
    ).toBeNull();
  });

  test("makes non-invalidation event behavior explicit", () => {
    const event = parseEvent({
      type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
      data: {
        runId: "run-1",
        status: "running",
        currentStepIndex: 0,
        steps: [],
      },
    });

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }
    expect(getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID)).toEqual([]);
  });
});

describe("matter refresh after a reconnect", () => {
  // Invalidation matches by key prefix, so a refresh covers a key when one of
  // its invalidated keys is a prefix of it.
  const covers = (refreshKeys: readonly QueryKey[], queryKey: QueryKey) =>
    refreshKeys.some(
      (refreshKey) =>
        refreshKey.length <= queryKey.length &&
        hashKey(queryKey.slice(0, refreshKey.length)) === hashKey(refreshKey),
    );

  test("covers every query any missed event could have changed", () => {
    const refreshActions = getWorkspaceReconnectQueryActions(WORKSPACE_ID);
    expect(
      refreshActions.every(
        ({ type }) => type === WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
      ),
    ).toBe(true);
    const refreshKeys = refreshActions.map(({ queryKey }) => queryKey);

    const missedEvents = Object.values(RESOURCE_TYPE).flatMap(
      (resourceType) => [
        {
          type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
          resourceType,
        },
        {
          type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
          resource: { type: resourceType, id: "resource-1" },
        },
        {
          type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
          resource: { type: resourceType, id: "resource-1" },
        },
      ],
    );
    for (const missed of missedEvents) {
      const event = parseEvent(missed);
      expect([missed, event]).not.toEqual([missed, null]);
      if (!event) {
        continue;
      }
      for (const { queryKey } of getWorkspaceRealtimeQueryActions(
        event,
        WORKSPACE_ID,
      )) {
        expect([missed, queryKey, covers(refreshKeys, queryKey)]).toEqual([
          missed,
          queryKey,
          true,
        ]);
      }
    }
  });
});

describe("matter query ownership", () => {
  test("selects every cached query naming the matter and no other", () => {
    const matter = "01975d0c-0000-7000-8000-00000000000a";
    const otherMatter = "01975d0c-0000-7000-8000-00000000000b";
    const queryClient = new QueryClient();
    const keysOf = (workspaceId: string) => [
      entitiesKeys.all(workspaceId),
      workspacesKeys.byId(workspaceId),
      workspacesKeys.overview(workspaceId),
      workspaceMembersQueryRoot(workspaceId),
      fileContentByFieldQueryRoot({ workspaceId, fieldId: "field-1" }),
    ];
    const organizationWide = [
      workspacesKeys.list("organization-1"),
      contactsQueryRoot(),
    ];
    for (const queryKey of [
      ...keysOf(matter),
      ...keysOf(otherMatter),
      ...organizationWide,
    ]) {
      queryClient.setQueryData(queryKey, { cached: true });
    }

    queryClient.removeQueries({
      predicate: (query) => isWorkspaceQueryKey(query.queryKey, matter),
    });

    const remaining = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => hashKey(query.queryKey))
      .toSorted();
    expect(remaining).toEqual(
      [...keysOf(otherMatter), ...organizationWide].map(hashKey).toSorted(),
    );
  });
});
