import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/statutes" });

// The build turns a `?worker&url` import into the emitted worker's URL; the
// chat overlay's chunk only holds on to it.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

const originalFetch = globalThis.fetch;
let availabilityReads = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      availabilityReads += 1;
      return Response.json({ available: true });
    }
    // A reader opening its chat for the first time has no thread yet.
    if (/\/chat\/threads\/[^/]+\/messages$/u.test(url.pathname)) {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    // The composer's matter picker: a member with no matters yet.
    if (url.pathname.endsWith("/workspaces/navigation")) {
      return Response.json({ items: [], nextCursor: null, workspaces: [] });
    }
    return Response.json({});
  },
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { LegalReaderAIChat } = await import("./legal-reader-ai-chat");

const READER_CONTENT = "Reader content";

afterEach(() => {
  cleanup();
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

afterAll(async () => {
  // Let React finish the work the readers scheduled before the DOM goes.
  await act(async () => {
    await sleep(50);
  });
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

// The statute and decision readers, in the main view and in their inspector
// views, all reach the chat through this component. Every route that mounts
// it provides the chat editor, but none may be trusted to put the AI key gate
// above it, so the overlay must bring its own rather than panic in a
// signed-in reader's face.
test.each([
  {
    type: "statute",
    documentId: "statute-89-2012",
    title: "Civil Code",
  } as const,
  {
    type: "decision",
    decisionId: "decision-1",
    caseNumber: "7 Azs 172/2025",
  } as const,
])(
  "a signed-in $type reader renders its chat without a route-level AI gate",
  async (activeLegal) => {
    availabilityReads = 0;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The law route as the app mounts it: a router and the chat editor
    // above the reader, and no AI key gate.
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => (
          <ChatEditorProvider>
            <LegalReaderAIChat activeLegal={activeLegal} aiMode="enabled">
              <p>{READER_CONTENT}</p>
            </LegalReaderAIChat>
          </ChatEditorProvider>
        ),
      }),
      history: createMemoryHistory({ initialEntries: ["/law/cz/statutes"] }),
    });
    await router.load();
    render(
      <QueryClientProvider client={queryClient}>
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
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <RouterProvider router={router} />
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );
    // Nothing above the reader provides the gate, so the only availability
    // read is the one the overlay host makes for itself. Without it the
    // overlay panics and its boundary shows the error fallback instead.
    await waitFor(
      () => {
        expect(availabilityReads).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(READER_CONTENT)).toBeDefined();
    expect(screen.queryByText(messages.common.somethingWentWrong)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    queryClient.clear();
  },
  // The overlay host is a lazy chunk; its first load under a busy runner
  // outlasts the default per-test timeout.
  30_000,
);
