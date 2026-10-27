import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const DECISION_PATH = "/law/cze/cases/synthetic/synthetic-dock-decision";

GlobalRegistrator.register({ url: `http://localhost:3000${DECISION_PATH}` });
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
    if (/\/chat\/decision-threads\/[^/]+$/u.test(path)) {
      return Response.json({ threadId: null });
    }
    if (/\/chat\/threads\/[^/]+\/messages$/u.test(path)) {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    if (path.endsWith("/workspaces/navigation")) {
      return Response.json({ items: [], nextCursor: null, workspaces: [] });
    }
    if (
      path.endsWith("/reader/answers") ||
      path.endsWith("/reader/annotations") ||
      path.endsWith("/citations")
    ) {
      return Response.json({ items: [], nextCursor: null, limit: 50 });
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  },
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, waitFor, within } =
  await import("@testing-library/react");
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
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { professionalUseOptions, sessionOptions } =
  await import("@/lib/auth-queries");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { PublicDecisionViewer } = await import("@/routes/law/-case-detail");
const { dockedChatLegalPayloads } =
  await import("../../../../../e2e/helpers/docked-chat-legal-payloads");
const { DECISION_AI_MODE } = await import("./decision-ai-mode");

// The member chunk and the chat overlay it enables are lazy; their first load
// under a busy runner outlasts the default per-test timeout.
const MEMBER_CHUNK_TIMEOUT_MS = 30_000;
const READER_SCROLL_TOP = 480;
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

/** A member's session, already read: the page renders as a member at once. */
const memberClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  client.setQueryData(
    professionalUseOptions(MEMBER_SESSION.session.userId).queryKey,
    {
      status: "accepted",
      statementVersion: "2026-10",
      termsVersion: "2026-10",
      acceptedAt: MEMBER_SESSION.session.createdAt.toISOString(),
    },
  );
  return client;
};

const renderDecisionPage = async (client: InstanceType<typeof QueryClient>) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [DECISION_PATH] }),
    routeTree: createRootRoute({
      component: () => (
        <PublicDecisionViewer
          decision={dockedChatLegalPayloads.decision}
          routeId="/law/$country/cases/$court/$slug"
        />
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
  const readers = container.querySelectorAll<HTMLElement>("[data-ai-mode]");
  if (readers.length !== 1) {
    panic(`Expected exactly one decision reader, found ${readers.length}`);
  }
  const [reader] = readers;
  return reader ?? panic("Expected the decision reader");
};

// A member's page shows the text before the member chunk (the AI key gate, the
// chat opener) has arrived. The chunk's arrival must reach the reader already
// on screen rather than replace it: a replaced reader drops the member back to
// the top of the decision and takes the focus out of the page.
// timeout: the member chunk and the chat overlay it enables are lazy chunks
// whose first load outlasts the default budget
test(
  "a member's reader keeps its node, scroll position and focus when the member chunk arrives",
  async () => {
    const view = await renderDecisionPage(memberClient());

    const gated = readerIn(view.container);
    expect(gated.dataset["aiMode"]).toBe(DECISION_AI_MODE.gated);
    const scroller =
      gated.querySelector<HTMLElement>(".reader-scroll") ??
      panic("Expected the reader's scroll container");
    const zoomIn = within(gated).getByRole("button", { name: "Zoom in" });
    act(() => {
      scroller.scrollTop = READER_SCROLL_TOP;
      zoomIn.focus();
    });
    // The fixture reaches the fault: the reader is scrolled and focused
    // before the chunk lands, so a replaced reader would read differently.
    expect(scroller.scrollTop).toBe(READER_SCROLL_TOP);
    expect(zoomIn.ownerDocument.activeElement).toBe(zoomIn);

    await waitFor(
      () => {
        expect(readerIn(view.container).dataset["aiMode"]).toBe(
          DECISION_AI_MODE.enabled,
        );
      },
      { timeout: MEMBER_CHUNK_TIMEOUT_MS },
    );

    const enabled = readerIn(view.container);
    expect(enabled).toBe(gated);
    expect(enabled.querySelector(".reader-scroll")).toBe(scroller);
    expect(scroller.isConnected).toBe(true);
    expect(scroller.scrollTop).toBe(READER_SCROLL_TOP);
    expect(zoomIn.ownerDocument.activeElement).toBe(zoomIn);
  },
  MEMBER_CHUNK_TIMEOUT_MS,
);
