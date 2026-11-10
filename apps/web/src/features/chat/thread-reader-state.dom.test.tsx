import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WebApiRoutes } from "@/lib/api";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const previousFetch = globalThis.fetch;
const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { useMarkChatThreadReadWhileOpen } =
  await import("./thread-reader-state");

type ThreadsPage = WebApiRoutes["chat"]["threads"]["get"]["response"][200];
type ThreadSlice = ThreadsPage["global"][number];

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const THREAD_ID = toChatThreadId("00000000-0000-7000-8000-0000000000c1");
const threadRef = { scope: "global", threadId: THREAD_ID } as const;

const slice = (readState: ThreadSlice["readState"]): ThreadSlice => ({
  context: { fileCount: 0, files: [], matterCount: 0, matters: [] },
  createdAt: "2026-10-11T09:00:00.000Z",
  decision: null,
  id: THREAD_ID,
  origin: "original",
  pinState: "unpinned",
  readState,
  title: "Limitation period for unpaid invoices",
  updatedAt: "2026-10-11T09:00:00.000Z",
  usedAnonymization: false,
});

const marks: unknown[] = [];

const serve = () => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body: unknown = await request.json();
      marks.push(body);
      return Response.json(body);
    },
    { preconnect: previousFetch.preconnect },
  );
};

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  testing.cleanup();
  globalThis.fetch = previousFetch;
  marks.length = 0;
  setVisibility("visible");
});
afterAll(async () => await unregisterDomEnvironment());

type Mount = {
  /** The reader's cached history, as the sidebar fetched it; none when absent. */
  cached?: ThreadSlice["readState"] | undefined;
  isGenerating?: boolean;
  threadExists?: boolean;
};

const mount = ({
  cached,
  isGenerating = false,
  threadExists = true,
}: Mount) => {
  serve();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const listKey = groupedChatThreadsOptions({
    activeOrganizationId: user.activeOrganizationId,
    userId: user.id,
  }).queryKey;
  if (cached !== undefined) {
    client.setQueryData(listKey, {
      pageParams: [""],
      pages: [{ global: [slice(cached)], nextCursor: null, workspaces: [] }],
    });
  }
  const hook = testing.renderHook(
    (props: { isGenerating: boolean }) => {
      useMarkChatThreadReadWhileOpen({
        isGenerating: props.isGenerating,
        threadExists,
        threadRef,
      });
    },
    {
      initialProps: { isGenerating },
      wrapper: ({ children }) => (
        <AnalyticsContext value={noopAnalytics}>
          <QueryClientProvider client={client}>
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              <AuthenticatedUserProvider user={user}>
                {children}
              </AuthenticatedUserProvider>
            </IntlProvider>
          </QueryClientProvider>
        </AnalyticsContext>
      ),
    },
  );
  const cachedState = () =>
    client.getQueryData(listKey)?.pages.at(0)?.global.at(0)?.readState;
  // A mark is built into the mutation cache the moment the effect asks for
  // it, so an empty cache right after a render means nothing was asked.
  const marksAsked = () => client.getMutationCache().getAll().length;
  return { cachedState, hook, marksAsked };
};

const READ = { readState: "read" };

const sentOneRead = async () => {
  await testing.waitFor(() => expect(marks).toEqual([READ]));
};

test("an open unread chat is marked read once, and its cached row says so", async () => {
  const { cachedState, marksAsked } = mount({ cached: "unread" });
  await sentOneRead();
  expect(cachedState()).toBe("read");
  expect(marksAsked()).toBe(1);
});

test("an open chat the cache already holds as read is left alone", () => {
  const { marksAsked } = mount({ cached: "read" });
  expect(marksAsked()).toBe(0);
});

test("a chat no cached list holds is marked, since its state is unknown", async () => {
  mount({});
  await sentOneRead();
});

test("a streaming answer waits until it has settled", async () => {
  const { hook, marksAsked } = mount({
    cached: "unread",
    isGenerating: true,
  });
  expect(marksAsked()).toBe(0);
  testing.act(() => {
    hook.rerender({ isGenerating: false });
  });
  await sentOneRead();
});

test("a draft with no stored thread marks nothing", () => {
  const { marksAsked } = mount({ threadExists: false });
  expect(marksAsked()).toBe(0);
});

test("a chat open in a hidden tab is marked once the tab is shown", async () => {
  setVisibility("hidden");
  const { marksAsked } = mount({ cached: "unread" });
  expect(marksAsked()).toBe(0);
  testing.act(() => {
    setVisibility("visible");
  });
  await sentOneRead();
});
