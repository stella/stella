import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === "/api/auth/get-session") {
      return Response.json(null);
    }
    return originalFetch(input, init);
  },
  { preconnect: originalFetch.preconnect },
);

const { cleanup, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChromeHeaderActionsSlot } = await import("@/lib/chrome-header-actions");
const { DecisionWorkspace } = await import("./decision-workspace");
const { dockedChatLegalPayloads } =
  await import("../../../../../e2e/helpers/docked-chat-legal-payloads");
const { default: messages } = await import("@/i18n/langs/en.json");

let client: InstanceType<typeof QueryClient> | undefined;
let restoreViewport: (() => void) | undefined;

afterEach(() => {
  cleanup();
  client?.clear();
  restoreViewport?.();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test.each([400, 580, 1440])(
  "the decision reader shares one pinned breadcrumb and zoom controls row at %ipx",
  async (width) => {
    const view = render(<div />);
    const browserWindow = view.baseElement.ownerDocument.defaultView;
    if (browserWindow === null) {
      panic("The rendered reader requires a DOM window");
    }
    const originalWidth = browserWindow.innerWidth;
    restoreViewport = () => {
      Object.defineProperty(browserWindow, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      browserWindow.dispatchEvent(new Event("resize"));
    };
    Object.defineProperty(browserWindow, "innerWidth", {
      configurable: true,
      value: width,
    });
    browserWindow.dispatchEvent(new Event("resize"));
    // This is a rendered layout test; query data is not needed for its controls.
    client = new QueryClient({
      defaultOptions: {
        queries: { enabled: false, gcTime: Infinity, retry: false },
      },
    });
    const decision = dockedChatLegalPayloads.decision;
    const root = createRootRoute({
      component: () => (
        <>
          <header>
            <ChromeHeaderActionsSlot />
          </header>
          <DecisionWorkspace
            aiMode="gated"
            decision={decision}
            decisionId={decision.id}
          />
        </>
      ),
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: root,
    });
    await router.load();
    view.rerender(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider>
            <QueryClientProvider client={client}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>,
    );
    // Wait for the header portal too: an unmounted slot would hide a duplicate.
    await waitFor(() => {
      expect(
        within(screen.getByRole("banner")).getByRole("button", {
          name: messages.caseLaw.reader.expandProvisions,
        }),
      ).toBeTruthy();
    });
    const breadcrumb = view.baseElement.querySelector(
      '[data-slot="reader-breadcrumb"]',
    );
    const row = breadcrumb?.parentElement;
    if (row === null || row === undefined) {
      panic("The rendered reader requires a breadcrumb controls row");
    }
    expect(screen.getByRole("banner").contains(row)).toBe(false);
    for (const name of ["Zoom in", "Zoom out", "Reset zoom"]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
      expect(within(row).getByRole("button", { name })).toBeTruthy();
      expect(
        view.baseElement.querySelectorAll(`button[aria-label="${name}"]`),
      ).toHaveLength(1);
    }
  },
);
