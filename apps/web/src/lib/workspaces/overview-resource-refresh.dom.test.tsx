import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

class OverviewEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly opened: OverviewEventSource[] = [];
  readonly url: string;
  readyState = 1;
  constructor(url: string) {
    super();
    this.url = url;
    OverviewEventSource.opened.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  drop() {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  }
  push() {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(
          resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.USER),
        ),
      }),
    );
  }
  close() {
    this.readyState = OverviewEventSource.CLOSED;
  }
}
const originalEventSource = globalThis.EventSource;
Object.assign(globalThis, { EventSource: OverviewEventSource });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { CancelledError, QueryClient, QueryClientProvider, QueryObserver } =
  await import("@tanstack/react-query");
const { updateUserResource } = await import("@/lib/account/update-user");
const { rootKeys } = await import("@/lib/auth-query-options");
const { ROUTE_QUERY_STALE_TIME_MS } = await import("@/lib/react-query");
const { useUserEventRefreshes } = await import("@/lib/user-events-sse");
const { getWorkspaceRealtimeQueryActions, getWorkspaceReconnectQueryActions } =
  await import("@/lib/workspace-realtime");
const { applyResourceQueryActions } =
  await import("@/testing/resource-query-actions.test-fixtures");
const { overviewOptions, workspacesKeys } = await import("./queries");

type Overview = Awaited<
  ReturnType<NonNullable<ReturnType<typeof overviewOptions>["queryFn"]>>
>;
const ORGANIZATION = "organization-overview";
const USER = "user-overview";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000002";
const FOREIGN_WORKSPACE = "00000000-0000-4000-8000-000000000003";
const INACTIVE_WORKSPACE = "00000000-0000-4000-8000-000000000004";
const snapshot = (name: string): Overview => ({
  entityCount: 1,
  documentCount: 0,
  taskCount: 0,
  upcomingAgenda: [],
  recentEntities: [
    {
      entityId: toSafeId<"entity">("00000000-0000-4000-8000-000000000005"),
      name: "Task",
      kind: "task",
      status: null,
      priority: null,
      listItemType: null,
      dueDate: null,
      mimeType: null,
      fieldId: null,
      propertyId: null,
      pdfFileId: null,
      encrypted: false,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: null,
      createdBy: name,
      createdByImage: null,
      createdByDeletedAt: null,
      assignedTo: name,
      assignedToImage: null,
      assignedToDeletedAt: null,
    },
  ],
});

const fixture = (
  profileOutcome: "success" | "refusal" | "session-switch" = "success",
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(rootKeys.session, {
    user: { id: USER },
    session: { activeOrganizationId: ORGANIZATION },
  });
  const subscriptions: (() => void)[] = [];
  const reads = new Map<string, number>();
  let name = "Before";
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/update-user")) {
          expect(request.method).toBe("POST");
          if (profileOutcome === "refusal") {
            return Response.json({ message: "Refused" }, { status: 403 });
          }
          name = "After";
          if (profileOutcome === "session-switch") {
            client.setQueryData(rootKeys.session, {
              user: { id: "next-user" },
              session: { activeOrganizationId: ORGANIZATION },
            });
          }
          return Response.json({ status: true });
        }
        const match = /\/workspaces\/([^/]+)\/overview$/u.exec(url.pathname);
        const workspaceId = match?.at(1);
        if (!workspaceId || request.method !== "GET") {
          throw new Error(
            `Unexpected overview transport: ${request.method} ${url.pathname}`,
          );
        }
        reads.set(workspaceId, (reads.get(workspaceId) ?? 0) + 1);
        return Response.json(snapshot(name));
      },
      { preconnect: () => undefined },
    ),
  );
  const observe = ({
    workspaceId,
    organizationId,
    active = true,
  }: {
    workspaceId: string;
    organizationId: string;
    active?: boolean;
  }) => {
    const options = {
      ...overviewOptions({ workspaceId, organizationId }),
      initialData: snapshot("Before"),
      staleTime: Infinity,
    };
    if (active) {
      const observer = new QueryObserver(client, options);
      subscriptions.push(observer.subscribe(() => undefined));
    } else {
      client.getQueryCache().build(client, options);
    }
    return {
      name: () =>
        client.getQueryData(options.queryKey)?.recentEntities.at(0)?.createdBy,
      assignee: () =>
        client.getQueryData(options.queryKey)?.recentEntities.at(0)?.assignedTo,
      reads: () => reads.get(workspaceId) ?? 0,
      stale: () => client.getQueryState(options.queryKey)?.isInvalidated,
    };
  };
  return {
    client,
    own: observe({ workspaceId: WORKSPACE, organizationId: ORGANIZATION }),
    sameOrganization: observe({
      workspaceId: OTHER_WORKSPACE,
      organizationId: ORGANIZATION,
    }),
    foreign: observe({
      workspaceId: FOREIGN_WORKSPACE,
      organizationId: "foreign-organization",
    }),
    inactive: observe({
      workspaceId: INACTIVE_WORKSPACE,
      organizationId: ORGANIZATION,
      active: false,
    }),
    change: () => {
      name = "After";
    },
    settle: async () =>
      await Promise.all(
        client
          .getQueryCache()
          .getAll()
          .map(async (query) => await query.promise),
      ),
    close: () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      client.clear();
      transport.mockRestore();
    },
  };
};

afterEach(() => {
  cleanup();
  OverviewEventSource.opened.length = 0;
});
afterAll(async () => {
  Object.assign(globalThis, { EventSource: originalEventSource });
  await unregisterDomEnvironment();
});

test.each([
  { outcome: "success", changed: true, refused: false },
  { outcome: "refusal", changed: false, refused: true },
  { outcome: "session-switch", changed: false, refused: false },
] as const)(
  "actual profile completion refreshes overview projections only for its captured session: $outcome",
  async ({ outcome, changed, refused }) => {
    const readers = fixture(outcome);
    try {
      const result = await updateUserResource({
        queryClient: readers.client,
        input: { name: "After" },
        owner: { userId: USER, organizationId: ORGANIZATION },
      });
      await readers.settle();
      expect(Result.isError(result)).toBe(refused);
      expect(readers.own.name()).toBe(changed ? "After" : "Before");
      expect(readers.own.assignee()).toBe(changed ? "After" : "Before");
      expect(readers.sameOrganization.name()).toBe(
        changed ? "After" : "Before",
      );
      expect(readers.foreign.name()).toBe("Before");
      expect(readers.foreign.reads()).toBe(0);
      expect(readers.inactive.stale()).toBe(changed);
      expect(readers.inactive.reads()).toBe(0);
    } finally {
      readers.close();
    }
  },
);

test.each(["event", "reconnect"])(
  "the actual organization user stream refreshes overview profile projections on %s",
  async (delivery) => {
    const readers = fixture();
    const view = renderHook(
      () =>
        useUserEventRefreshes({ organizationId: ORGANIZATION, userId: USER }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={readers.client}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    try {
      expect(OverviewEventSource.opened).toHaveLength(1);
      const stream =
        OverviewEventSource.opened.at(0) ??
        panic("Missing overview user stream");
      expect(stream.url).toEndWith("/notifications/events");
      stream.open();
      expect(readers.own.reads()).toBe(0);
      readers.change();
      await act(async () => {
        if (delivery === "event") {
          stream.push();
        } else {
          stream.drop();
          stream.open();
        }
        await readers.settle();
      });
      expect(readers.own.name()).toBe("After");
      expect(readers.own.assignee()).toBe("After");
      expect(readers.sameOrganization.name()).toBe("After");
      expect(readers.foreign.name()).toBe("Before");
      expect(readers.foreign.reads()).toBe(0);
      expect(readers.inactive.stale()).toBe(true);
      expect(readers.inactive.reads()).toBe(0);
    } finally {
      view.unmount();
      readers.close();
    }
  },
);

test.each(["entity", "reconnect"])(
  "existing workspace %s refresh preserves its established cache coverage",
  async (delivery) => {
    const readers = fixture();
    try {
      readers.change();
      const scope = { workspaceId: WORKSPACE, queryClient: readers.client };
      await applyResourceQueryActions(
        readers.client,
        delivery === "entity"
          ? getWorkspaceRealtimeQueryActions(
              resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
              scope,
            )
          : getWorkspaceReconnectQueryActions(scope),
      );
      await readers.settle();
      expect(readers.own.name()).toBe("After");
      // Reconnect retains the legacy workspaces root refresh; ENTITY facts are precise.
      const broadReconnect = delivery === "reconnect";
      expect(readers.sameOrganization.name()).toBe(
        broadReconnect ? "After" : "Before",
      );
      expect(readers.sameOrganization.reads()).toBe(broadReconnect ? 1 : 0);
      expect(readers.foreign.reads()).toBe(broadReconnect ? 1 : 0);
      expect(readers.inactive.stale()).toBe(broadReconnect);
      expect(readers.inactive.reads()).toBe(0);
    } finally {
      readers.close();
    }
  },
);

test("overview identity, freshness and transport cancellation stay unchanged", async () => {
  const options = overviewOptions({
    workspaceId: WORKSPACE,
    organizationId: ORGANIZATION,
  });
  expect([...options.queryKey]).toEqual(workspacesKeys.overview(WORKSPACE));
  expect(options.staleTime).toBe(ROUTE_QUERY_STALE_TIME_MS);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const reached = Promise.withResolvers<Request>();
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toEndWith(
          `/workspaces/${WORKSPACE}/overview`,
        );
        return await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () =>
              reject(
                new Error("Request aborted", { cause: request.signal.reason }),
              ),
            { once: true },
          );
          reached.resolve(request);
        });
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    const failed = rejectionOf(client.query(options));
    const request = await reached.promise;
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(await failed).toBeInstanceOf(CancelledError);
    expect(request.signal.aborted).toBe(true);
  } finally {
    await client.cancelQueries();
    client.clear();
    transport.mockRestore();
  }
});
