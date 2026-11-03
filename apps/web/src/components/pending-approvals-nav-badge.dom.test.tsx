import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const ORGANIZATION_ID = "organization-1";
const USER_ID = "member-1";

/** What the approval queue answers: its bounded count, or a failure. */
let queue: { type: "count"; pendingCount: number } | { type: "failed" } = {
  type: "count",
  pendingCount: 0,
};
let queueReads: URLSearchParams[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/v1/u, "");
    if (request.method === "GET" && path === "/time-entries/approval-queue") {
      queueReads.push(url.searchParams);
      if (queue.type === "failed") {
        return Response.json({ code: "unavailable" }, { status: 503 });
      }
      return Response.json({
        items: [],
        nextCursor: null,
        limit: 1,
        pendingCount: queue.pendingCount,
      });
    }
    throw new TypeError(`Unexpected request: ${request.method} ${path}`);
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { PendingApprovalsNavBadge } =
  await import("@/components/pending-approvals-nav-badge");

afterEach(async () => {
  await testing.act(async () => {
    testing.cleanup();
  });
  queue = { type: "count", pendingCount: 0 };
  queueReads = [];
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = testing.render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <nav aria-label="Primary">
            <PendingApprovalsNavBadge
              organizationId={ORGANIZATION_ID}
              userId={USER_ID}
            />
          </nav>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, nav: view.getByRole("navigation") };
};

describe("pending approvals badge on the Time link", () => {
  test("shows how many submitted entries wait for the signed-in person", async () => {
    queue = { type: "count", pendingCount: 3 };
    const { nav } = mount();

    await testing.waitFor(() => expect(nav.textContent).toBe("3"));
    // One bounded read of the queue: the count, not the entries.
    expect(queueReads).toHaveLength(1);
    expect(queueReads[0]?.get("limit")).toBe("1");
  });

  test("shows the queue's capped count as the API reports it", async () => {
    queue = { type: "count", pendingCount: 1000 };
    const { nav } = mount();

    await testing.waitFor(() => expect(nav.textContent).toBe("1,000"));
  });

  test("shows nothing while no entry waits", async () => {
    queue = { type: "count", pendingCount: 0 };
    const { client, nav } = mount();

    await testing.waitFor(() =>
      expect(
        client.getQueryState([
          "timeApprovals",
          ORGANIZATION_ID,
          USER_ID,
          "pending",
        ])?.status,
      ).toBe("success"),
    );
    expect(nav.textContent).toBe("");
  });

  test("shows nothing when the count cannot be read", async () => {
    queue = { type: "failed" };
    const { client, nav } = mount();

    await testing.waitFor(() =>
      expect(
        client.getQueryState([
          "timeApprovals",
          ORGANIZATION_ID,
          USER_ID,
          "pending",
        ])?.status,
      ).toBe("error"),
    );
    expect(nav.textContent).toBe("");
  });
});
