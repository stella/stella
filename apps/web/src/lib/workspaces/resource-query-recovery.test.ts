import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { deferred } from "@stll/test-kit";

import { captureSessionQueryOwner } from "@/lib/account/auth-query-owner";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { sessionOptions } from "@/lib/auth-query-options";
import { readQueryResult } from "@/lib/errors/query-result";
import { installSessionCacheGuard } from "@/lib/session-cache-guard";
import {
  getWorkspaceRealtimeQueryActions,
  organizationResourceQueryActions,
  resourceMutation,
  resourceQueryOptions,
} from "@/lib/workspace-realtime";
import { applyWorkspaceRealtimeQueryActions } from "@/lib/workspace-sse";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { getRealtimeRefreshScheduler } from "@/lib/workspaces/realtime-refresh";

const WORKSPACE = "workspace-a";
const clients: { client: QueryClient; uninstall: () => void }[] = [];
const observers: (() => void)[] = [];
const createClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const uninstall = installSessionCacheGuard(client, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  clients.push({ client, uninstall });
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  return client;
};
afterEach(() => {
  for (const unsubscribe of observers.splice(0)) {
    unsubscribe();
  }
  for (const { client, uninstall } of clients) {
    uninstall();
    client.clear();
  }
  clients.length = 0;
});
const failSession = async (client: QueryClient) => {
  const outcome = await client
    .query({
      ...sessionOptions,
      staleTime: 0,
      queryFn: async () =>
        readQueryResult(Result.err(new Error("Session read failed"))),
    })
    .catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect(client.getQueryState(sessionOptions.queryKey)?.status).toBe("error");
};

const projection = (client: QueryClient) => {
  const options = resourceQueryOptions(
    queryOptions({
      queryKey: [
        "recovery-projection",
        MEMBER_SESSION.session.activeOrganizationId,
        MEMBER_SESSION.user.id,
      ],
      initialData: 0,
      queryFn: async () => 1,
      staleTime: Infinity,
    }),
    {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: {
        type: "organization",
        organizationId: MEMBER_SESSION.session.activeOrganizationId,
        userId: MEMBER_SESSION.user.id,
      },
    },
  );
  const observer = new QueryObserver(client, options);
  return () => client.getQueryState(observer.options.queryKey)?.isInvalidated;
};

test("legacy workspace facts are retained through a failed same-owner session read", async () => {
  const client = createClient();
  const key = entitiesKeys.all(WORKSPACE);
  client.setQueryData(key, 0);
  const owner = captureSessionQueryOwner(client);
  await failSession(client);
  applyWorkspaceRealtimeQueryActions(
    client,
    getWorkspaceRealtimeQueryActions(
      resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
      { workspaceId: WORKSPACE, queryClient: client, owner },
    ),
  );
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  expect(captureSessionQueryOwner(client)).toBe(owner);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

test("an identified organization event waits for the same owner's successful session recovery", async () => {
  const client = createClient();
  const isStale = projection(client);
  const owner = captureSessionQueryOwner(client);
  await failSession(client);
  const scheduler = getRealtimeRefreshScheduler(client);
  for (const { queryKey, ...context } of organizationResourceQueryActions({
    queryClient: client,
    organizationId: MEMBER_SESSION.session.activeOrganizationId,
    resources: [RESOURCE_TYPE.ENTITY],
    owner,
  })) {
    scheduler.refresh(queryKey, undefined, context);
  }
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  expect(captureSessionQueryOwner(client)).toBe(owner);
  expect(isStale()).toBe(true);
});

test("a local committed write retains exact projection work until same-owner recovery", async () => {
  const client = createClient();
  const isStale = projection(client);
  const reached = deferred<undefined>();
  const complete = deferred<undefined>();
  const write = resourceMutation({
    mutation: "renameEntity",
    queryClient: client,
    mutationFn: async (_variables: {
      workspaceId: string;
      entityId: string;
    }) => {
      reached.resolve(undefined);
      await complete.promise;
    },
  })({ workspaceId: WORKSPACE, entityId: "entity-a" });
  try {
    await reached.promise;
    await failSession(client);
    complete.resolve(undefined);
    await write;
    client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    expect(isStale()).toBe(true);
  } finally {
    complete.resolve(undefined);
    await write;
  }
});

const activeProjection = (client: QueryClient) => {
  let reads = 0;
  const settled = deferred();
  const read = async () => ++reads;
  const options = resourceQueryOptions(
    queryOptions({
      queryKey: [
        "active-recovery-projection",
        MEMBER_SESSION.session.activeOrganizationId,
        MEMBER_SESSION.user.id,
      ],
      initialData: 0,
      staleTime: Infinity,
      queryFn: read,
    }),
    {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: {
        type: "organization",
        organizationId: MEMBER_SESSION.session.activeOrganizationId,
        userId: MEMBER_SESSION.user.id,
      },
    },
  );
  const observer = new QueryObserver(client, options);
  observers.push(
    observer.subscribe((result) => {
      if (result.data === 1 && !result.isFetching) {
        settled.resolve();
      }
    }),
  );
  const deliver = (owner: ReturnType<typeof captureSessionQueryOwner>) => {
    for (const { queryKey, ...context } of organizationResourceQueryActions({
      queryClient: client,
      organizationId: MEMBER_SESSION.session.activeOrganizationId,
      resources: [RESOURCE_TYPE.ENTITY],
      owner,
    })) {
      getRealtimeRefreshScheduler(client).refresh(queryKey, undefined, context);
    }
  };
  return { options, deliver, reads: () => reads, settled: settled.promise };
};

test("an active identified reader fetches exactly once after successful same-owner recovery", async () => {
  const client = createClient();
  const view = activeProjection(client);
  const owner = captureSessionQueryOwner(client);
  await failSession(client);
  view.deliver(owner);
  expect(client.getQueryState(view.options.queryKey)?.isInvalidated).toBe(true);
  expect(view.reads()).toBe(0);
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  await view.settled;
  expect(view.reads()).toBe(1);
  expect(client.getQueryState(view.options.queryKey)?.isInvalidated).toBe(
    false,
  );
});

test("a retired owner cannot drain retained active-reader work", async () => {
  const client = createClient();
  const view = activeProjection(client);
  const owner = captureSessionQueryOwner(client);
  await failSession(client);
  view.deliver(owner);
  client.setQueryData(sessionOptions.queryKey, {
    ...MEMBER_SESSION,
    session: {
      ...MEMBER_SESSION.session,
      activeOrganizationId: "other-organization",
    },
  });
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  expect(captureSessionQueryOwner(client)).not.toBe(owner);
  expect(view.reads()).toBe(0);
});

test("replacing the exact Query discards its retained fact", async () => {
  const client = createClient();
  const view = activeProjection(client);
  const owner = captureSessionQueryOwner(client);
  await failSession(client);
  view.deliver(owner);
  client.removeQueries({ queryKey: view.options.queryKey, exact: true });
  client.setQueryData(view.options.queryKey, 0);
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  expect(view.reads()).toBe(0);
  expect(client.getQueryState(view.options.queryKey)?.isInvalidated).toBe(
    false,
  );
});

test("a committed local write refreshes its active reader once after authority returns", async () => {
  const client = createClient();
  const view = activeProjection(client);
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
  })({ workspaceId: WORKSPACE, entityId: "entity-a" });
  try {
    await reached.promise;
    await failSession(client);
    complete.resolve();
    await write;
    expect(view.reads()).toBe(0);
    expect(client.getQueryState(view.options.queryKey)?.isInvalidated).toBe(
      true,
    );
    client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    await view.settled;
    expect(view.reads()).toBe(1);
  } finally {
    complete.resolve();
    await write;
  }
});
