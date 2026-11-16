import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, spyOn, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { deferred } from "@stll/test-kit";

import { captureSessionQueryOwner } from "@/lib/account/auth-query-owner";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { roleOptions, sessionOptions } from "@/lib/auth-queries";
import { inboxCountOptions } from "@/lib/inbox/queries";
import { organizationListOptions } from "@/lib/organization/queries";
import { installSessionCacheGuard } from "@/lib/session-cache-guard";
import {
  getWorkspaceRealtimeQueryActions,
  organizationResourceQueryActions,
  resourceMutation,
  resourceQueryOptions,
} from "@/lib/workspace-realtime";
import { applyWorkspaceRealtimeQueryActions } from "@/lib/workspace-sse";
import {
  workspacesOptions,
  workspacesRouteOptions,
} from "@/lib/workspaces/queries";
import type { WorkspacesData } from "@/lib/workspaces/queries";
import { getRealtimeRefreshScheduler } from "@/lib/workspaces/realtime-refresh";

const ORGANIZATION = MEMBER_SESSION.session.activeOrganizationId;
const USER = MEMBER_SESSION.user.id;
const clients: { client: QueryClient; uninstall: () => void }[] = [];
const unsubscribes: (() => void)[] = [];
const createClient = ({ authenticated = true } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const uninstall = installSessionCacheGuard(client, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  clients.push({ client, uninstall });
  if (authenticated) {
    client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  }
  return client;
};
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe();
  }
  for (const { client, uninstall } of clients.splice(0)) {
    uninstall();
    client.clear();
  }
});
const observeList = (client: QueryClient, organizationId: string) => {
  const base = workspacesRouteOptions(organizationId);
  const response: WorkspacesData = {
    creationCapacity: { canCreate: true, limit: 1000 },
    workspaces: [],
  };
  let reads = 0;
  const settled = deferred();
  const read = async () => {
    reads += 1;
    return response;
  };
  const observer = new QueryObserver(client, {
    ...base,
    initialData: response,
    staleTime: Infinity,
    queryFn: read,
  });
  unsubscribes.push(
    observer.subscribe((result) => {
      if (reads > 0 && !result.isFetching) {
        settled.resolve();
      }
    }),
  );
  return {
    queryKey: base.queryKey,
    reads: () => reads,
    settled: settled.promise,
  };
};

test.each([
  { resource: RESOURCE_TYPE.WORKSPACE },
  { resource: RESOURCE_TYPE.ENTITY },
  { resource: RESOURCE_TYPE.FIELD },
  { resource: RESOURCE_TYPE.ENTITY_VERSION },
  { resource: RESOURCE_TYPE.CONTACT },
  { resource: RESOURCE_TYPE.USER },
])(
  "a workspace list projection refreshes for its declared $resource dependency without fetching a foreign organization",
  async ({ resource }) => {
    const client = createClient();
    const own = observeList(client, ORGANIZATION);
    const foreign = observeList(client, "other-organization");
    applyWorkspaceRealtimeQueryActions(
      client,
      getWorkspaceRealtimeQueryActions(
        resourceSetUpdatedRealtimeEvent(resource),
        {
          workspaceId: "workspace-one",
          queryClient: client,
          owner: captureSessionQueryOwner(client),
        },
      ),
    );
    await own.settled;
    expect(own.reads()).toBe(1);
    expect(foreign.reads()).toBe(0);
    expect(client.getQueryState(foreign.queryKey)?.isInvalidated).toBe(false);
  },
);

test("workspace list route and mounted options retain their distinct freshness policies", () => {
  const route = workspacesRouteOptions(ORGANIZATION);
  const mounted = workspacesOptions(ORGANIZATION);
  expect([...mounted.queryKey]).toEqual([...route.queryKey]);
  expect(mounted.queryFn).toBeDefined();
  expect(route.staleTime).toBe(300_000);
  expect(mounted.staleTime).toBe(0);
  expect(mounted.refetchOnMount).toBe("always");
});

test("same-organization foreign-user projections become stale without fetching either active or inactive identities", async () => {
  const client = createClient();
  const observe = ({ userId, active }: { userId: string; active: boolean }) => {
    const base = inboxCountOptions(ORGANIZATION, userId);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return { count: reads };
    };
    const options = {
      ...base,
      initialData: { count: 0 },
      staleTime: Infinity,
      refetchInterval: false as const,
      queryFn: read,
    };
    if (active) {
      const observer = new QueryObserver(client, options);
      unsubscribes.push(observer.subscribe(() => undefined));
    } else {
      client.getQueryCache().build(client, options);
    }
    return {
      reads: () => reads,
      stale: () => client.getQueryState(base.queryKey)?.isInvalidated,
    };
  };
  const own = observe({ userId: USER, active: true });
  const activeForeign = observe({ userId: "another-user", active: true });
  const inactiveForeign = observe({ userId: "previous-user", active: false });
  const scheduler = getRealtimeRefreshScheduler(client);
  await Promise.all(
    organizationResourceQueryActions({
      queryClient: client,
      organizationId: ORGANIZATION,
      resources: [RESOURCE_TYPE.ENTITY],
      owner: captureSessionQueryOwner(client),
    }).map(
      async ({ queryKey, ...context }) =>
        await scheduler.invalidateImmediately(queryKey, context),
    ),
  );
  expect(own.reads()).toBe(1);
  expect(activeForeign.reads()).toBe(0);
  expect(inactiveForeign.reads()).toBe(0);
  expect(activeForeign.stale()).toBe(true);
  expect(inactiveForeign.stale()).toBe(true);
});

test("the organization membership list is user-wide but cannot fetch another user's key", async () => {
  const client = createClient();
  const observe = (userId: string) => {
    const base = organizationListOptions(userId);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [];
    };
    const observer = new QueryObserver(client, {
      ...base,
      initialData: [],
      staleTime: Infinity,
      queryFn: read,
    });
    unsubscribes.push(observer.subscribe(() => undefined));
    return () => reads;
  };
  const ownReads = observe(USER);
  const otherReads = observe("another-user");
  const scheduler = getRealtimeRefreshScheduler(client);
  await Promise.all(
    organizationResourceQueryActions({
      queryClient: client,
      organizationId: ORGANIZATION,
      resources: [RESOURCE_TYPE.ORGANIZATION],
      owner: captureSessionQueryOwner(client),
    }).map(
      async ({ queryKey, ...context }) =>
        await scheduler.invalidateImmediately(queryKey, context),
    ),
  );
  expect(ownReads()).toBe(1);
  expect(otherReads()).toBe(0);
});

test("current-session refresh requires the actual accepted bootstrap Query binding", async () => {
  const client = createClient();
  let roleReads = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toEndWith("/get-active-member-role");
      roleReads += 1;
      return Response.json({ role: "member" });
    },
  );
  try {
    await client.query(roleOptions);
    const observer = new QueryObserver(client, {
      ...roleOptions,
      staleTime: Infinity,
    });
    unsubscribes.push(observer.subscribe(() => undefined));
    let unboundReads = 0;
    const readUnbound = async () => {
      unboundReads += 1;
      return "member";
    };
    const unbound = new QueryObserver(
      client,
      resourceQueryOptions(
        {
          queryKey: ["unbound-bootstrap"],
          initialData: "member",
          staleTime: Infinity,
          queryFn: readUnbound,
        },
        { resources: [RESOURCE_TYPE.USER], scope: { type: "current-session" } },
      ),
    );
    unsubscribes.push(unbound.subscribe(() => undefined));
    const scheduler = getRealtimeRefreshScheduler(client);
    await Promise.all(
      organizationResourceQueryActions({
        queryClient: client,
        organizationId: ORGANIZATION,
        resources: [RESOURCE_TYPE.USER],
        owner: captureSessionQueryOwner(client),
      }).map(
        async ({ queryKey, ...context }) =>
          await scheduler.invalidateImmediately(queryKey, context),
      ),
    );
    expect(roleReads).toBe(2);
    expect(unboundReads).toBe(0);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("a mutation missing its initial owner cannot gain projection authority after sign-in", async () => {
  const client = createClient({ authenticated: false });
  const list = observeList(client, ORGANIZATION);
  const reached = deferred();
  const complete = deferred();
  const write = resourceMutation({
    mutation: "renameEntity",
    queryClient: client,
    mutationFn: async (_variables: {
      workspaceId: string;
      entityId: string;
    }) => {
      reached.resolve();
      await complete.promise;
    },
  })({ workspaceId: "workspace-one", entityId: "entity-one" });
  try {
    await reached.promise;
    client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    complete.resolve();
    await write;
    expect(list.reads()).toBe(0);
    expect(client.getQueryState(list.queryKey)?.isInvalidated).toBe(false);
  } finally {
    complete.resolve();
    await write;
  }
});
