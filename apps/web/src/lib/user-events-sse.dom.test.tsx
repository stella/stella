import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueryMeta } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  chatQueueChangedRealtimeEvent,
  chatRunsChangedRealtimeEvent,
  chatThreadsChangedRealtimeEvent,
  newNotificationRealtimeEvent,
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceMemberPreview } from "@/lib/workspaces/queries/workspace-member-previews";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });

/** One fake stream per `new EventSource`, so a test can push frames into it. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly opened: FakeEventSource[] = [];
  readyState = 1;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.opened.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  /** The browser lost the connection and is retrying on its own. */
  drop() {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  }
  push(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
Object.assign(globalThis, { EventSource: FakeEventSource });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, QueryObserver } =
  await import("@tanstack/react-query");
const { activeChatRunsOptions } = await import("@/features/chat/active-runs");
const { chatKeys } = await import("@/features/chat/chat-query-contract");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { contactsKeys } = await import("@/lib/contacts/queries");
const { notificationsOptions } = await import("@/lib/notification-queries");
const { useUserEventRefreshes } = await import("./user-events-sse");
const { taskDetailOptions, taskKeys } =
  await import("@/lib/workspaces/queries/tasks");
const { workspaceMemberPreviewsOptions } =
  await import("@/lib/workspaces/queries/workspace-member-previews");
const { resourceQueryOptions } = await import("@/lib/workspace-realtime");
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { sessionOptions } = await import("@/lib/auth-query-options");
const { readQueryResult } = await import("@/lib/errors/query-result");

afterEach(() => {
  cleanup();
  FakeEventSource.opened.length = 0;
});
afterAll(async () => await unregisterDomEnvironment());

const ORGANIZATION = "organization-one";
const USER = "user-one";
const STREAM_SESSION = {
  ...MEMBER_SESSION,
  user: { ...MEMBER_SESSION.user, id: USER },
  session: {
    ...MEMBER_SESSION.session,
    userId: USER,
    activeOrganizationId: ORGANIZATION,
  },
};
const createStreamClient = (
  options?: ConstructorParameters<typeof QueryClient>[0],
) => {
  const client = new QueryClient(options);
  client.setQueryData(sessionOptions.queryKey, STREAM_SESSION);
  return client;
};

const mount = () => {
  const queryClient = createStreamClient();
  const contactsList = contactsKeys.list(ORGANIZATION, { q: "" });
  const otherFirmContacts = contactsKeys.lists("organization-two");
  const notifications = notificationsOptions({
    organizationId: ORGANIZATION,
    userId: USER,
  }).queryKey;
  const activeRuns = activeChatRunsOptions({
    activeOrganizationId: ORGANIZATION,
    userId: USER,
  }).queryKey;
  // The history's pinned section: any grouped list of the reader's chats.
  const chatThreads = groupedChatThreadsOptions({
    activeOrganizationId: ORGANIZATION,
    pinState: "pinned",
    userId: USER,
  }).queryKey;
  // One open chat's queue.
  const chatQueue = chatKeys.queue(ORGANIZATION, USER, "thread-one");
  for (const key of [
    activeRuns,
    chatQueue,
    chatThreads,
    contactsList,
    otherFirmContacts,
  ]) {
    queryClient.setQueryData(key, { seeded: true });
  }
  // The notification refresh trims an infinite list to its first page.
  queryClient.setQueryData(notifications, {
    pages: [{ items: [], nextCursor: null, limit: 20, unreadCount: 0 }],
    pageParams: [null],
  });
  renderHook(
    () => useUserEventRefreshes({ organizationId: ORGANIZATION, userId: USER }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  const isStale = (key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true;
  return {
    activeRuns,
    chatQueue,
    chatThreads,
    contactsList,
    isStale,
    notifications,
    otherFirmContacts,
  };
};

test("the app shell opens exactly one user stream", () => {
  mount();
  expect(FakeEventSource.opened).toHaveLength(1);
  expect(FakeEventSource.opened.at(0)?.url).toEndWith("/notifications/events");
});

test("an organization contact change refreshes that firm's contacts only", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened
      .at(0)
      ?.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.CONTACT));
  });

  expect(view.isStale(view.contactsList)).toBe(true);
  expect(view.isStale(view.otherFirmContacts)).toBe(false);
  expect(view.isStale(view.notifications)).toBe(false);
});

test("a notification event refreshes the notifications", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.push(newNotificationRealtimeEvent());
  });

  expect(view.isStale(view.notifications)).toBe(true);
  expect(view.isStale(view.contactsList)).toBe(false);
});

test("a chat run change refreshes the active runs, the chat lists, whose rows turn unread, and the queues a turn takes from or holds", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.push(chatRunsChangedRealtimeEvent());
  });

  expect(view.isStale(view.activeRuns)).toBe(true);
  expect(view.isStale(view.chatThreads)).toBe(true);
  expect(view.isStale(view.chatQueue)).toBe(true);
  expect(view.isStale(view.notifications)).toBe(false);
  expect(view.isStale(view.contactsList)).toBe(false);
});

test("a chat read or pin change refreshes the chat lists only", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.push(chatThreadsChangedRealtimeEvent());
  });

  expect(view.isStale(view.chatThreads)).toBe(true);
  expect(view.isStale(view.activeRuns)).toBe(false);
  expect(view.isStale(view.notifications)).toBe(false);
  expect(view.isStale(view.contactsList)).toBe(false);
});

test("a queue change refreshes the open chats' queues only", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.push(chatQueueChangedRealtimeEvent());
  });

  expect(view.isStale(view.chatQueue)).toBe(true);
  expect(view.isStale(view.activeRuns)).toBe(false);
  expect(view.isStale(view.chatThreads)).toBe(false);
  expect(view.isStale(view.notifications)).toBe(false);
});

test("the first open re-reads nothing: the queries were just fetched", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.open();
  });

  expect(view.isStale(view.activeRuns)).toBe(false);
  expect(view.isStale(view.notifications)).toBe(false);
  expect(view.isStale(view.contactsList)).toBe(false);
});

test("a reopen after a drop re-reads everything the stream keeps fresh", async () => {
  const view = mount();
  const stream = FakeEventSource.opened.at(0);
  await act(async () => {
    stream?.open();
    stream?.drop();
    stream?.open();
  });

  expect(view.isStale(view.activeRuns)).toBe(true);
  expect(view.isStale(view.chatThreads)).toBe(true);
  expect(view.isStale(view.chatQueue)).toBe(true);
  expect(view.isStale(view.notifications)).toBe(true);
  expect(view.isStale(view.contactsList)).toBe(true);
  expect(view.isStale(view.otherFirmContacts)).toBe(false);
});

test("a frame that is no known event refreshes nothing", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened
      .at(0)
      ?.push({ type: "not-a-user-event", data: null });
  });

  expect(view.isStale(view.activeRuns)).toBe(false);
  expect(view.isStale(view.notifications)).toBe(false);
  expect(view.isStale(view.contactsList)).toBe(false);
});

test.each(["event", "reconnect"])(
  "organization user projections refresh exact owner queries on %s",
  async (delivery) => {
    const client = createStreamClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const base = taskDetailOptions({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000002",
      organizationId: ORGANIZATION,
    });
    let name = "Before";
    const subscriptions: (() => void)[] = [];
    const observe = (options: {
      queryKey: readonly unknown[];
      meta: QueryMeta;
    }) => {
      const observer = new QueryObserver(client, {
        ...options,
        initialData: "Before",
        queryFn: async () => name,
      });
      subscriptions.push(observer.subscribe(() => undefined));
      return () => observer.getCurrentResult().data;
    };
    const own = observe(base);
    const wrongOrganization = observe(
      resourceQueryOptions(
        {
          queryKey: [
            ...taskKeys.detail(
              "00000000-0000-4000-8000-000000000001",
              "00000000-0000-4000-8000-000000000002",
            ),
            "other-organization",
          ],
        },
        {
          resources: [RESOURCE_TYPE.ENTITY],
          scope: { type: "workspace", workspaceId: "same-workspace" },
          organizationReads: {
            organizationId: "organization-two",
            resources: [RESOURCE_TYPE.USER],
          },
        },
      ),
    );
    const contactProjection = observe(
      resourceQueryOptions(
        {
          queryKey: [
            ...taskKeys.detail(
              "00000000-0000-4000-8000-000000000001",
              "00000000-0000-4000-8000-000000000002",
            ),
            "other-resource",
          ],
        },
        {
          resources: [RESOURCE_TYPE.ENTITY],
          scope: { type: "workspace", workspaceId: "same-workspace" },
          organizationReads: {
            organizationId: ORGANIZATION,
            resources: [RESOURCE_TYPE.CONTACT],
          },
        },
      ),
    );
    const view = renderHook(
      ({ userId }) =>
        useUserEventRefreshes({ organizationId: ORGANIZATION, userId }),
      {
        initialProps: { userId: USER },
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      const stream = FakeEventSource.opened.at(0);
      name = "After";
      await act(async () => {
        stream?.open();
        if (delivery === "event") {
          stream?.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.USER));
        } else {
          stream?.drop();
          stream?.open();
        }
        await Promise.all(
          client
            .getQueryCache()
            .findAll()
            .map(async (query) => await query.promise),
        );
      });
      expect(own()).toBe("After");
      expect(wrongOrganization()).toBe("Before");
      expect(contactProjection()).toBe(
        delivery === "event" ? "Before" : "After",
      );
      await act(async () => {
        view.rerender({ userId: "new-user" });
      });
      expect(stream?.readyState).toBe(FakeEventSource.CLOSED);
      name = "Wrong old user";
      await act(async () => {
        stream?.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.USER));
        stream?.open();
        await Promise.all(
          client
            .getQueryCache()
            .findAll()
            .map(async (query) => await query.promise),
        );
      });
      expect(own()).toBe("After");
    } finally {
      view.unmount();
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      client.clear();
    }
  },
);

test.each(["event", "reconnect"])(
  "the existing user stream refreshes organization member previews on %s without fetching inactive identities",
  async (delivery) => {
    const client = createStreamClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const subscriptions: (() => void)[] = [];
    let revision = 0;
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const observe = ({
      organizationId,
      userId,
      workspaceIds,
      active,
    }: {
      organizationId: string;
      userId: string;
      workspaceIds: readonly string[];
      active: boolean;
    }) => {
      const options = workspaceMemberPreviewsOptions({
        organizationId,
        userId,
        workspaceIds,
      });
      let reads = 0;
      const response = (
        total: number,
      ): { previews: WorkspaceMemberPreview[] } => ({
        previews: workspaceIds.map((id) => ({
          workspaceId: toSafeId<"workspace">(id),
          total,
          members:
            total === 0
              ? []
              : [
                  {
                    userId: toSafeId<"user">(userId),
                    name: "Member",
                    email: "member@example.test",
                    image: null,
                  },
                ],
        })),
      });
      // Model the server's changing answer; the real option factory owns identity.
      const read = async () => {
        reads += 1;
        return response(revision);
      };
      const owned = {
        queryKey: options.queryKey,
        meta: options.meta,
        initialData: response(0),
        staleTime: Infinity,
        queryFn: read,
      };
      if (active) {
        const observer = new QueryObserver(client, owned);
        subscriptions.push(observer.subscribe(() => undefined));
      } else {
        client.getQueryCache().build(client, owned);
      }
      return {
        data: () =>
          client.getQueryData(options.queryKey)?.previews.at(0)?.total,
        stale: () => client.getQueryState(options.queryKey)?.isInvalidated,
        reads: () => reads,
      };
    };
    const own = observe({
      organizationId: ORGANIZATION,
      userId: USER,
      workspaceIds: [workspaceId],
      active: true,
    });
    // Organization events intentionally have no workspace ID: every active batch refreshes.
    const otherBatch = observe({
      organizationId: ORGANIZATION,
      userId: USER,
      workspaceIds: ["00000000-0000-4000-8000-000000000002"],
      active: true,
    });
    const oldUser = observe({
      organizationId: ORGANIZATION,
      userId: "previous-user",
      workspaceIds: [workspaceId],
      active: false,
    });
    const otherOrganization = observe({
      organizationId: "organization-two",
      userId: USER,
      workspaceIds: [workspaceId],
      active: true,
    });
    const view = renderHook(
      () =>
        useUserEventRefreshes({ organizationId: ORGANIZATION, userId: USER }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      expect(FakeEventSource.opened).toHaveLength(1);
      const stream =
        FakeEventSource.opened.at(0) ?? panic("Missing user stream");
      expect(stream.url).toEndWith("/notifications/events");
      revision = 1;
      await act(async () => {
        stream.open();
        if (delivery === "event") {
          stream.push(resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.WORKSPACE));
        } else {
          stream.drop();
          stream.open();
        }
        await Promise.all(
          client
            .getQueryCache()
            .findAll()
            .map(async (query) => await query.promise),
        );
      });
      expect(own.data()).toBe(1);
      expect(own.reads()).toBe(1);
      expect(otherBatch.data()).toBe(1);
      expect(otherBatch.reads()).toBe(1);
      expect(oldUser.data()).toBe(0);
      expect(oldUser.stale()).toBe(true);
      expect(oldUser.reads()).toBe(0);
      expect(otherOrganization.data()).toBe(0);
      expect(otherOrganization.stale()).toBe(false);
      expect(otherOrganization.reads()).toBe(0);
    } finally {
      view.unmount();
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      client.clear();
    }
  },
);

test.each([
  { name: "confirmed" },
  { name: "recovering" },
  { name: "unobserved" },
])(
  "a %s first subscription reconciles only a deferred-authority gap",
  async ({ name: initialSession }) => {
    const client = createStreamClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    let reads = 0;
    const read = async () => ++reads;
    const options = resourceQueryOptions(
      {
        queryKey: ["stream-recovery", ORGANIZATION, USER],
        initialData: 0,
        staleTime: Infinity,
        queryFn: read,
      },
      {
        resources: [RESOURCE_TYPE.ENTITY],
        scope: {
          type: "organization",
          organizationId: ORGANIZATION,
          userId: USER,
        },
      },
    );
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    if (initialSession !== "confirmed") {
      // The retained-owner case models a previously installed app guard.
      if (initialSession === "recovering") {
        const { observeAuthQueryOwner } =
          await import("@/lib/account/auth-query-owner");
        observeAuthQueryOwner(client);
      }
      const outcome = await client
        .query({
          ...sessionOptions,
          staleTime: 0,
          queryFn: async () =>
            readQueryResult(Result.err(new Error("Session read failed"))),
        })
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(client.getQueryState(sessionOptions.queryKey)?.status).toBe(
        "error",
      );
    }
    const view = renderHook(
      () =>
        useUserEventRefreshes({ organizationId: ORGANIZATION, userId: USER }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      expect(FakeEventSource.opened).toHaveLength(
        initialSession === "confirmed" ? 1 : 0,
      );
      if (initialSession !== "confirmed") {
        expect(reads).toBe(0);
        await act(async () => {
          client.setQueryData(sessionOptions.queryKey, STREAM_SESSION);
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
          stream.dispatchEvent(new Event("open"));
        }
      });
      expect(reads).toBe(0);
      await act(async () => {
        live.at(0)?.open();
        await Promise.all(
          client
            .getQueryCache()
            .findAll()
            .map(async (query) => await query.promise),
        );
      });
      expect(reads).toBe(initialSession === "confirmed" ? 0 : 1);
    } finally {
      view.unmount();
      unsubscribe();
      client.clear();
    }
  },
);
