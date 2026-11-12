import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatBackgroundTasks } =
  await import("@/components/chat/chat-background-tasks");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const COUNT_PATH = `/v1/chat/threads/${THREAD_ID}/background-tasks`;

/** What the server answers for the chat's count. */
const server = { count: 0, reads: 0 };

const clients: InstanceType<typeof QueryClient>[] = [];
beforeEach(() => {
  server.count = 0;
  server.reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        if (url.pathname !== COUNT_PATH) {
          return Response.json({});
        }
        server.reads += 1;
        return Response.json({ count: server.count });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
afterEach(async () => {
  mock.restore();
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** The chat's count line as the page renders it, between turns or not. */
const renderCount = (generationActive: boolean) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-1",
            email: "member@example.test",
            id: "user-1",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <ChatBackgroundTasks
            generationActive={generationActive}
            threadId={THREAD_ID}
          />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("a chat shows what its agent left running on a computer, whatever the chat runs on now", async () => {
  server.count = 2;
  renderCount(false);
  expect(await screen.findByText("2 background tasks running")).toBeTruthy();
});

test("a running turn holds the work: nothing shows while it runs", async () => {
  server.count = 1;
  const view = renderCount(true);
  await waitFor(() => {
    expect(server.reads).toBe(1);
  });
  expect(view.queryByRole("status")).toBeNull();
});

test("a chat with nothing in the background shows nothing", async () => {
  const view = renderCount(false);
  await waitFor(() => {
    expect(server.reads).toBe(1);
  });
  expect(view.queryByRole("status")).toBeNull();
});
