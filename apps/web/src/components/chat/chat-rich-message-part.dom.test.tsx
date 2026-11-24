import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { RichChatPart } from "@/components/chat/chat-rich-message-part";

// The production shape: the browser calls the API through the web app's own
// `/api` mount, and the public API is a separate origin.
const APP_ORIGIN = "https://app.example.test";
Object.assign(import.meta.env, {
  VITE_API_URL: "https://api.example.test",
  VITE_BROWSER_API_URL: `${APP_ORIGIN}/api`,
  VITE_PUBLIC_APP_URL: APP_ORIGIN,
});
GlobalRegistrator.register({ url: `${APP_ORIGIN}/chat` });

// The renderer is the MCP Apps client; the host's decision is what it is
// handed: the sandbox that frames the app.
await mock.module("@mcp-ui/client", () => ({
  AppRenderer: ({ sandbox }: { sandbox: { url: URL } }) => (
    <output aria-label="App sandbox">{sandbox.url.href}</output>
  ),
}));

// The web app does not depend on the app bundles package; the stored part
// carries this URI and the bundle endpoint answers with it.
const CASE_LAW_RESULTS_URI = "ui://stella/case-law-results";

type BundleAnswer = "ok" | "fails";
let bundleAnswer: BundleAnswer = "ok";
const bundleRequests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/chat/mcp-apps/")) {
      return Response.json({ error: "unexpected request" }, { status: 599 });
    }
    bundleRequests.push(url);
    return bundleAnswer === "ok"
      ? Response.json({
          uri: CASE_LAW_RESULTS_URI,
          html: "<!doctype html><title>Case law</title>",
        })
      : Response.json(
          { error: { code: "internal_error", message: "Bundle failed" } },
          { status: 500 },
        );
  },
  { preconnect: () => undefined },
);

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { buildStellaMcpAppPart } =
  await import("@stll/api-contract/stella-mcp-app");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { toSafeId } = await import("@/lib/safe-id");
const { ChatRichMessagePart } =
  await import("@/components/chat/chat-rich-message-part");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  bundleAnswer = "ok";
  bundleRequests.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const threadRef = {
  scope: "global",
  threadId: toSafeId<"chatThread">("019df73f-4d68-7002-956c-4e11ad647dab"),
} as const;

const built = buildStellaMcpAppPart({
  call: {
    input: { queries: ["výpověď", "výpovědní doba"], country: "cze" },
    result: {
      structuredContent: { results: [{}, {}, {}], nextCursor: null },
    },
  },
  toolCallId: "call_search_case_law",
  toolName: "search_case_law",
  uri: CASE_LAW_RESULTS_URI,
});
if (Result.isError(built)) {
  panic(built.error);
}
const appPart = built.value satisfies RichChatPart;

const renderPart = (part: RichChatPart) => {
  const fingerprints: string[] = [];
  const analytics = {
    ...noopAnalytics,
    captureError: (_error, options) => {
      fingerprints.push(options.fingerprintKey);
    },
  } satisfies typeof noopAnalytics;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <AnalyticsContext value={analytics}>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatRichMessagePart part={part} threadRef={threadRef} />
        </IntlProvider>
      </QueryClientProvider>
    </AnalyticsContext>,
  );
  return { view, fingerprints };
};

type RenderedPart = ReturnType<typeof renderPart>["view"];

const caseLawTrigger = (view: RenderedPart) =>
  view.getByRole("button", { name: /Case Law/u });

const openCaseLaw = async (view: RenderedPart) => {
  await act(async () => {
    fireEvent.click(caseLawTrigger(view));
  });
};

describe("stella app parts in a chat thread", () => {
  test("starts a case-law result list as one closed line", () => {
    const { view, fingerprints } = renderPart(appPart);

    const trigger = caseLawTrigger(view);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("výpověď · výpovědní doba");
    expect(trigger.textContent).toContain("3 decisions");
    expect(view.queryByLabelText("App sandbox")).toBeNull();
    expect(bundleRequests).toEqual([]);
    expect(fingerprints).toEqual([]);
  });

  test("keeps an opened case-law list mounted when it closes again", async () => {
    const { view } = renderPart(appPart);

    await openCaseLaw(view);
    await waitFor(() => view.getByLabelText("App sandbox"));
    expect(caseLawTrigger(view).getAttribute("aria-expanded")).toBe("true");

    await openCaseLaw(view);
    expect(caseLawTrigger(view).getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("output")).not.toBeNull();
    expect(bundleRequests).toHaveLength(1);
  });

  test("frames a stored app when the browser API shares the page's origin", async () => {
    const { view, fingerprints } = renderPart(appPart);
    await openCaseLaw(view);

    const sandbox = await waitFor(
      () => view.getByLabelText("App sandbox").textContent,
    );
    expect(new URL(sandbox).origin).toBe("https://api.example.test");
    expect(bundleRequests).toHaveLength(1);
    expect(view.container.textContent).not.toContain(
      messages.chat.richContentUnavailable,
    );
    expect(fingerprints).toEqual([]);
  });

  test("reports a part the host refuses instead of hiding it", async () => {
    const broken = {
      ...appPart,
      resource: { ...appPart.resource, text: "{}" },
    } satisfies RichChatPart;
    const { view, fingerprints } = renderPart(broken);

    await waitFor(() => {
      expect(fingerprints).toEqual([
        "ChatRichContent.refused:app-part-contract",
      ]);
    });
    expect(view.container.textContent).toContain(
      messages.chat.richContentUnavailable,
    );
    expect(bundleRequests).toEqual([]);
  });

  test("reports an app document that did not load", async () => {
    bundleAnswer = "fails";
    const { view, fingerprints } = renderPart(appPart);
    await openCaseLaw(view);

    await waitFor(() => {
      expect(fingerprints).toEqual(["ChatRichContent.refused:app-bundle"]);
    });
    expect(view.container.textContent).toContain(
      messages.chat.richContentUnavailable,
    );
  });
});
