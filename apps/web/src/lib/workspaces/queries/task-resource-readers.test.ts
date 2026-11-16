import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import type { QueryKey, QueryMeta } from "@tanstack/react-query";
import { expect, spyOn, test } from "bun:test";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  getWorkspaceRealtimeQueryActions,
  resourceMutation,
} from "@/lib/workspace-realtime";
import { calendarTasksOptions } from "@/lib/workspaces/queries/calendar-tasks";
import { invoiceByIdOptions } from "@/lib/workspaces/queries/invoices";
import { taskDetailOptions } from "@/lib/workspaces/queries/tasks";
import { applyResourceQueryActions } from "@/testing/resource-query-actions.test-fixtures";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const datePropertyId = "00000000-0000-4000-8000-000000000004";

const calendarInput = (workspace: string) => ({
  workspaceId: workspace,
  dateFrom: "2026-11-01T00:00:00Z",
  dateTo: "2026-12-01T00:00:00Z",
  datePropertyIds: ["_due-date", datePropertyId],
  filters: [],
  sorts: [{ propertyId: datePropertyId, desc: false }],
});

const taskReaders = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  let revision = 0;
  const subscriptions: (() => void)[] = [];
  // Keep real factory identities and metadata; the read boundary returns a revision.
  const observe = ({
    queryKey,
    meta,
  }: {
    queryKey: QueryKey;
    meta: QueryMeta;
  }) => {
    let requests = 0;
    const read = async () => {
      requests += 1;
      return revision;
    };
    const options = queryOptions({
      queryKey,
      meta,
      initialData: 0,
      queryFn: read,
    });
    const observer = new QueryObserver(queryClient, options);
    subscriptions.push(observer.subscribe(() => undefined));
    return {
      data: () => observer.getCurrentResult().data,
      requests: () => requests,
      stale: () => queryClient.getQueryState(queryKey)?.isInvalidated,
    };
  };
  const detail = observe(
    taskDetailOptions({
      workspaceId,
      taskId,
      organizationId: "organization-a",
    }),
  );
  const calendar = observe(
    calendarTasksOptions(calendarInput(workspaceId), "organization-a"),
  );
  const otherDetail = observe(
    taskDetailOptions({
      workspaceId: otherWorkspaceId,
      taskId,
      organizationId: "organization-a",
    }),
  );
  const otherCalendar = observe(
    calendarTasksOptions(calendarInput(otherWorkspaceId), "organization-a"),
  );
  const invoice = observe(invoiceByIdOptions(workspaceId, "invoice-fixture"));
  return {
    queryClient,
    detail,
    calendar,
    otherDetail,
    otherCalendar,
    invoice,
    commit: () => {
      revision += 1;
    },
    settled: async () => {
      await Promise.all(
        queryClient
          .getQueryCache()
          .getAll()
          .map(async (query) => await query.promise),
      );
    },
    dispose: () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      queryClient.clear();
    },
  };
};

test("a committed task change refreshes active detail and calendar readers only in its matter", async () => {
  const fixture = taskReaders();
  const update = resourceMutation({
    mutation: "updateTask",
    queryClient: fixture.queryClient,
    mutationFn: async (_variables: {
      workspaceId: string;
      entityId: string;
    }) => {
      fixture.commit();
    },
  });
  try {
    await update({ workspaceId, entityId: taskId });
    await fixture.settled();
    for (const reader of [fixture.detail, fixture.calendar]) {
      expect(reader.data()).toBe(1);
      expect(reader.requests()).toBe(1);
      expect(reader.stale()).toBe(false);
    }
    for (const reader of [
      fixture.otherDetail,
      fixture.otherCalendar,
      fixture.invoice,
    ]) {
      expect(reader.data()).toBe(0);
      expect(reader.requests()).toBe(0);
      expect(reader.stale()).toBe(false);
    }
  } finally {
    fixture.dispose();
  }
});

test("a refused task write leaves its detail and calendar readers fresh", async () => {
  const fixture = taskReaders();
  const refusal = new Error("Task is read-only");
  const update = resourceMutation({
    mutation: "updateTask",
    queryClient: fixture.queryClient,
    mutationFn: async (_variables: {
      workspaceId: string;
      entityId: string;
    }) => {
      throw refusal;
    },
  });
  try {
    expect(await rejectionOf(update({ workspaceId, entityId: taskId }))).toBe(
      refusal,
    );
    await fixture.settled();
    for (const reader of [
      fixture.detail,
      fixture.calendar,
      fixture.otherDetail,
      fixture.otherCalendar,
      fixture.invoice,
    ]) {
      expect(reader.data()).toBe(0);
      expect(reader.requests()).toBe(0);
      expect(reader.stale()).toBe(false);
    }
  } finally {
    fixture.dispose();
  }
});

for (const resourceType of [
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.FIELD,
  RESOURCE_TYPE.PROPERTY,
]) {
  test(`${resourceType} realtime changes refresh the calendar without crossing matter or resource boundaries`, async () => {
    const fixture = taskReaders();
    try {
      fixture.commit();
      await applyResourceQueryActions(
        fixture.queryClient,
        getWorkspaceRealtimeQueryActions(
          {
            type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
            resourceType,
          },
          { workspaceId, queryClient: fixture.queryClient },
        ),
      );
      await fixture.settled();
      expect(fixture.calendar.data()).toBe(1);
      expect(fixture.calendar.requests()).toBe(1);
      expect(fixture.detail.requests()).toBe(
        resourceType === RESOURCE_TYPE.ENTITY ? 1 : 0,
      );
      for (const reader of [
        fixture.otherDetail,
        fixture.otherCalendar,
        fixture.invoice,
      ]) {
        expect(reader.data()).toBe(0);
        expect(reader.requests()).toBe(0);
        expect(reader.stale()).toBe(false);
      }
    } finally {
      fixture.dispose();
    }
  });
}

for (const { name, read } of [
  {
    name: "detail",
    read: async (client: QueryClient) =>
      await client.query(
        taskDetailOptions({
          workspaceId,
          taskId,
          organizationId: "organization-a",
        }),
      ),
  },
  {
    name: "calendar",
    read: async (client: QueryClient) =>
      await client.query(
        calendarTasksOptions(calendarInput(workspaceId), "organization-a"),
      ),
  },
]) {
  test(`cancelling the ${name} query aborts its actual API transport`, async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const started = Promise.withResolvers<AbortSignal>();
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Query transport has no abort signal");
          }
          started.resolve(signal);
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(new Error("Request aborted", { cause: signal.reason })),
              {
                once: true,
              },
            );
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const rejected = rejectionOf(read(queryClient).then(() => undefined));
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      await queryClient.cancelQueries();
      expect(signal.aborted).toBe(true);
      expect(await rejected).toBeInstanceOf(Error);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
      transport.mockRestore();
    }
  });
}
