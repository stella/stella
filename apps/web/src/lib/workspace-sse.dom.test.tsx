import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { resourceMutationDigest } from "@stll/api-contract/realtime-mutation-digest";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { deferred } from "@stll/test-kit";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly opened: FakeEventSource[] = [];
  readyState = 1;
  constructor(_url: string) {
    super();
    FakeEventSource.opened.push(this);
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  push(event: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
  failClosed() {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatchEvent(new Event("error"));
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
Object.assign(globalThis, { EventSource: FakeEventSource });

const { act, cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, QueryObserver } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { observeAuthQueryOwner } =
  await import("@/lib/account/auth-query-owner");
const { sessionOptions } = await import("@/lib/auth-query-options");
const { readQueryResult } = await import("@/lib/errors/query-result");
const { resourceQueryOptions } = await import("@/lib/workspace-realtime");
const { useWorkspaceSSE } = await import("@/lib/workspace-sse");
const { runWorkspaceMutation } =
  await import("@/lib/workspaces/workspace-mutation");

const WORKSPACE = "workspace-one";
const identity = {
  userId: MEMBER_SESSION.user.id,
  organizationId: MEMBER_SESSION.session.activeOrganizationId,
};
const clients: {
  client: InstanceType<typeof QueryClient>;
  unsubscribe: () => void;
}[] = [];

afterEach(() => {
  cleanup();
  for (const { client, unsubscribe } of clients.splice(0)) {
    unsubscribe();
    client.clear();
  }
  FakeEventSource.opened.length = 0;
});
afterAll(async () => await unregisterDomEnvironment());

const createView = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  let reads = 0;
  const read = async () => ++reads;
  const options = resourceQueryOptions(
    {
      queryKey: ["workspace-stream-projection", WORKSPACE],
      initialData: 0,
      staleTime: Infinity,
      queryFn: read,
    },
    {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: { type: "organization", organizationId: identity.organizationId },
    },
  );
  const observer = new QueryObserver(client, options);
  clients.push({ client, unsubscribe: observer.subscribe(() => undefined) });
  return { client, reads: () => reads };
};
const failSession = async (client: InstanceType<typeof QueryClient>) => {
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
const mount = async (
  client: InstanceType<typeof QueryClient>,
  onEvent?: Parameters<typeof useWorkspaceSSE>[1]["onEvent"],
) => {
  const Subscription = () => {
    useWorkspaceSSE(WORKSPACE, { identity, onEvent });
    return null;
  };
  const root = router.createRootRoute({ component: Subscription });
  const appRouter = router.createRouter({
    routeTree: root,
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  const content = (activeClient: InstanceType<typeof QueryClient>) => (
    <QueryClientProvider client={activeClient}>
      <IntlProvider
        locale="en"
        messages={bundledEnglishMessages}
        timeZone="UTC"
      >
        <router.RouterProvider router={appRouter} />
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(content(client));
  return {
    view,
    appRouter,
    rerenderClient: (nextClient: InstanceType<typeof QueryClient>) =>
      view.rerender(content(nextClient)),
  };
};
const settleReads = async (client: InstanceType<typeof QueryClient>) => {
  await Promise.all(
    client
      .getQueryCache()
      .findAll()
      .map(async (query) => await query.promise),
  );
};

test.each([
  { name: "confirmed" },
  { name: "recovering" },
  { name: "unobserved" },
])(
  "workspace %s first open reconciles only an authority-wait gap",
  async ({ name: initialSession }) => {
    const view = createView();
    if (initialSession !== "confirmed") {
      if (initialSession === "recovering") {
        observeAuthQueryOwner(view.client);
      }
      await failSession(view.client);
    }
    await mount(view.client);
    expect(FakeEventSource.opened).toHaveLength(
      initialSession === "confirmed" ? 1 : 0,
    );
    if (initialSession !== "confirmed") {
      await act(async () => {
        view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
      });
    }
    const live = FakeEventSource.opened.filter(
      (stream) => stream.readyState !== FakeEventSource.CLOSED,
    );
    expect(live).toHaveLength(1);
    await act(async () => {
      for (const stream of FakeEventSource.opened.filter(
        (candidate) => candidate.readyState === FakeEventSource.CLOSED,
      )) {
        stream.open();
      }
    });
    expect(view.reads()).toBe(0);
    await act(async () => {
      live.at(0)?.open();
      await settleReads(view.client);
    });
    expect(view.reads()).toBe(initialSession === "confirmed" ? 0 : 1);
  },
);

test("a retired workspace source cannot consume the pending connection gap", async () => {
  const view = createView();
  observeAuthQueryOwner(view.client);
  await failSession(view.client);
  await mount(view.client);
  await act(async () => {
    view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  });
  const retired = FakeEventSource.opened.at(-1);
  await act(async () => {
    view.client.setQueryData(sessionOptions.queryKey, {
      ...MEMBER_SESSION,
      session: {
        ...MEMBER_SESSION.session,
        activeOrganizationId: "other-organization",
      },
    });
    view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    // The old handler can run before React commits the new subscription effect.
    retired?.open();
  });
  expect(view.reads()).toBe(0);
  expect(retired?.readyState).toBe(FakeEventSource.CLOSED);
  const live = FakeEventSource.opened.filter(
    (stream) => stream.readyState !== FakeEventSource.CLOSED,
  );
  expect(live).toHaveLength(1);
  await act(async () => {
    live.at(0)?.open();
    await settleReads(view.client);
  });
  expect(view.reads()).toBe(1);
});

test("retired workspace messages cannot reach the current route callback", async () => {
  const view = createView();
  let callbacks = 0;
  const { appRouter } = await mount(view.client, () => {
    callbacks += 1;
  });
  const retired = FakeEventSource.opened.at(-1);
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 404 }),
  );
  try {
    await act(async () => {
      view.client.setQueryData(sessionOptions.queryKey, {
        ...MEMBER_SESSION,
        session: {
          ...MEMBER_SESSION.session,
          activeOrganizationId: "other-organization",
        },
      });
      view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
      retired?.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY));
      retired?.failClosed();
    });
    expect(callbacks).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appRouter.state.location.pathname).toBe("/");
    await act(async () => {
      await failSession(view.client);
    });
    const current = FakeEventSource.opened.at(-1);
    await act(async () => {
      current?.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY));
    });
    expect(callbacks).toBe(1);
  } finally {
    fetchSpy.mockRestore();
  }
});

test.each([
  { name: "same-owner", retire: false },
  { name: "retired-owner", retire: true },
])(
  "a queued deletion flush respects its $name subscription at cleanup",
  async ({ retire }) => {
    const view = createView();
    const { view: mounted } = await mount(view.client);
    const stream = FakeEventSource.opened.at(-1);
    const key = ["entities", WORKSPACE, "entity-one"];
    view.client.setQueryData(key, "old");
    await act(async () => {
      stream?.push({
        type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
        resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-one" },
      });
      if (retire) {
        view.client.setQueryData(sessionOptions.queryKey, {
          ...MEMBER_SESSION,
          session: {
            ...MEMBER_SESSION.session,
            activeOrganizationId: "other-organization",
          },
        });
        view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
        view.client.setQueryData(key, "rebuilt");
      }
      mounted.unmount();
    });
    expect(view.client.getQueryData(key)).toBe(retire ? "rebuilt" : undefined);
  },
);

test.each([
  { name: "same-owner", retire: false },
  { name: "retired-owner", retire: true },
])(
  "an already-started matter exit cleans only its $name cache",
  async ({ retire }) => {
    const view = createView();
    const { view: mounted, appRouter } = await mount(view.client);
    const reached = deferred();
    const complete = deferred();
    const navigate = spyOn(appRouter, "navigate").mockImplementation(
      async () => {
        reached.resolve();
        await complete.promise;
      },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const key = ["entities", WORKSPACE, "rebuilt-entity"];
    try {
      await act(async () => {
        FakeEventSource.opened.at(-1)?.failClosed();
        await reached.promise;
      });
      expect(navigate).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (retire) {
          view.client.setQueryData(sessionOptions.queryKey, {
            ...MEMBER_SESSION,
            session: {
              ...MEMBER_SESSION.session,
              activeOrganizationId: "other-organization",
            },
          });
          view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
        } else {
          // Normal navigation may unmount before its promise settles.
          mounted.unmount();
        }
        view.client.setQueryData(key, "rebuilt");
        complete.resolve();
        await navigate.mock.results.at(0)?.value;
        await settleReads(view.client);
      });
      expect(view.client.getQueryData(key)).toBe(
        retire ? "rebuilt" : undefined,
      );
    } finally {
      complete.resolve();
      await navigate.mock.results.at(0)?.value;
      navigate.mockRestore();
      fetchSpy.mockRestore();
    }
  },
);

test.each([
  { name: "same-owner", retire: false },
  { name: "retired-owner", retire: true },
])(
  "a pending mutation echo applies only for its $name connection after refusal",
  async ({ retire }) => {
    const view = createView();
    let callbacks = 0;
    await mount(view.client, () => {
      callbacks += 1;
    });
    const registered = deferred<string>();
    const response = deferred<string>();
    const completion = runWorkspaceMutation({
      client: view.client,
      queryKeys: [],
      request: async (mutationId) => {
        registered.resolve(mutationId);
        return await response.promise;
      },
    });
    try {
      const mutationId = await registered.promise;
      const event = resourceSetUpdatedRealtimeEvent(
        RESOURCE_TYPE.ENTITY,
        await resourceMutationDigest(mutationId),
      );
      await act(async () => {
        FakeEventSource.opened.at(-1)?.push(event);
      });
      expect(callbacks).toBe(0);
      await act(async () => {
        if (retire) {
          view.client.setQueryData(sessionOptions.queryKey, {
            ...MEMBER_SESSION,
            session: {
              ...MEMBER_SESSION.session,
              activeOrganizationId: "other-organization",
            },
          });
          view.client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
        }
        response.reject(new Error("Request refused"));
        expect(Result.isError(await completion)).toBe(true);
      });
      expect(callbacks).toBe(retire ? 0 : 1);
    } finally {
      response.resolve("finished");
      await completion;
    }
  },
);

test("provider replacement flushes a pending deletion only into the subscription's client", async () => {
  const previous = createView();
  const next = createView();
  const mounted = await mount(previous.client);
  const key = ["entities", WORKSPACE, "entity-one"];
  previous.client.setQueryData(key, "previous");
  next.client.setQueryData(key, "rebuilt");
  await act(async () => {
    FakeEventSource.opened.at(-1)?.push({
      type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-one" },
    });
    mounted.rerenderClient(next.client);
  });
  expect(previous.client.getQueryData(key)).toBeUndefined();
  expect(next.client.getQueryData(key)).toBe("rebuilt");
  expect(next.reads()).toBe(0);
});
