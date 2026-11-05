import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  chatRunsChangedRealtimeEvent,
  newNotificationRealtimeEvent,
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

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
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { activeChatRunsOptions } = await import("@/features/chat/active-runs");
const { contactsKeys } = await import("@/lib/contacts/queries");
const { notificationsOptions } = await import("@/lib/notification-queries");
const { useUserEventRefreshes } = await import("./user-events-sse");

afterEach(() => {
  cleanup();
  FakeEventSource.opened.length = 0;
});
afterAll(async () => await unregisterDomEnvironment());

const ORGANIZATION = "organization-one";
const USER = "user-one";

const mount = () => {
  const queryClient = new QueryClient();
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
  for (const key of [activeRuns, contactsList, otherFirmContacts]) {
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

test("a chat run change refreshes the active runs only", async () => {
  const view = mount();
  await act(async () => {
    FakeEventSource.opened.at(0)?.push(chatRunsChangedRealtimeEvent());
  });

  expect(view.isStale(view.activeRuns)).toBe(true);
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
