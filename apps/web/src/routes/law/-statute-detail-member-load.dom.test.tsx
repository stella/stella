import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const STATUTE_PATH = "/law/cz/statutes/synthetic-statute";

GlobalRegistrator.register({ url: `http://localhost:3000${STATUTE_PATH}` });
// The build turns a `?worker&url` import into the emitted worker's URL; the
// member's chat overlay only holds on to it.
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
// The member's page reads come back empty or missing: the test is about which
// reader stays on screen, not about what it shows.
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/organization-settings/ai-availability")) {
      return Response.json(aiAvailableResponse());
    }
    if (/\/chat\/threads\/[^/]+\/messages$/u.test(path)) {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    if (path.endsWith("/workspaces/navigation")) {
      return Response.json({ items: [], nextCursor: null, workspaces: [] });
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  },
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { DOCUMENT_OCR_AVAILABILITY } =
  await import("@stll/api-contract/document-ocr-availability");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { NO_STATUTE_COMPARE } =
  await import("@/features/statutes/statute-compare-search");
const { PublicStatuteViewer } = await import("@/routes/law/-statute-detail");
const { dockedChatLegalPayloads } =
  await import("../../../e2e/helpers/docked-chat-legal-payloads");

const READER_SCROLL_TOP = 480;
const MEMBER = {
  activeOrganizationId: "organization-1",
  email: "member@example.test",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const initialInspector = useInspectorTabsStore.getState();
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useInspectorTabsStore.setState(initialInspector, true);
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

// The public shell provides the member from the page's first render, the way
// `PublicWorkspaceShell` does once the session is read.
const renderStatutePage = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const { statute, versions } = dockedChatLegalPayloads;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [STATUTE_PATH] }),
    routeTree: createRootRoute({
      component: () => (
        <AuthenticatedUserProvider user={MEMBER}>
          <PublicStatuteViewer
            asOf={undefined}
            comparison={NO_STATUTE_COMPARE}
            requestedJump={undefined}
            searchQuery={undefined}
            statute={statute}
            versions={versions.items}
            windowGap={null}
            work={statute}
          />
        </AuthenticatedUserProvider>
      ),
    }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider>
            <ActionCapabilitiesProvider
              value={resolveActionCapabilities({
                role: "member",
                ai: true,
                deepl: false,
                ocr: DOCUMENT_OCR_AVAILABILITY.unconfigured,
                desktop: "none",
                settings: undefined,
              })}
            >
              <WebReaderPresentationProvider>
                <RouterProvider router={router} />
              </WebReaderPresentationProvider>
            </ActionCapabilitiesProvider>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const readerIn = (container: HTMLElement) => {
  const readers = container.querySelectorAll<HTMLElement>(".reader-scroll");
  if (readers.length !== 1) {
    panic(`Expected exactly one statute reader, found ${readers.length}`);
  }
  const [reader] = readers;
  return reader ?? panic("Expected the statute reader");
};

// A member's page shows the wording before the member's chat (its composer,
// key gate and conversation) has arrived. The chat's arrival must reach the
// reader already on screen rather than replace it: a replaced reader drops
// the member back to the top of the act and takes the focus out of the page.
test("a member's statute reader keeps its node, scroll position and focus when the member's chat arrives", async () => {
  const view = await renderStatutePage();

  const scroller = readerIn(view.container);
  // The fixture's wording carries no control of its own, so a provision
  // takes the focus the way an in-page jump target does.
  const focusTarget =
    scroller.querySelector<HTMLElement>(
      "[data-slot='reader-document-column'] [id]",
    ) ?? panic("Expected an anchored provision in the statute reader");
  focusTarget.tabIndex = -1;
  act(() => {
    scroller.scrollTop = READER_SCROLL_TOP;
    focusTarget.focus();
  });
  // The fixture reaches the fault: the reader is scrolled and focused
  // before the chat lands, so a replaced reader would read differently.
  expect(scroller.scrollTop).toBe(READER_SCROLL_TOP);
  expect(focusTarget.ownerDocument.activeElement).toBe(focusTarget);
  // Nothing of the member's chat is on screen yet.
  expect(screen.queryByRole("textbox")).toBeNull();

  await screen.findByRole("textbox");

  expect(readerIn(view.container)).toBe(scroller);
  expect(scroller.isConnected).toBe(true);
  expect(scroller.contains(focusTarget)).toBe(true);
  expect(scroller.scrollTop).toBe(READER_SCROLL_TOP);
  expect(focusTarget.ownerDocument.activeElement).toBe(focusTarget);
});
