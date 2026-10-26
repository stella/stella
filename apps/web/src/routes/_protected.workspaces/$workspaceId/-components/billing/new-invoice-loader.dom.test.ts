import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/matter-1/invoices/new",
});

const WORKSPACE = "matter-1";
const USER = "approver-1";

const requests: string[] = [];
const originalFetch = globalThis.fetch;
// Both pending-approval lists are unavailable.
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(new URL(request.url).pathname);
    return new Response("unavailable", { status: 503 });
  },
  { preconnect: () => undefined },
);

const query = await import("@tanstack/react-query");
const { rootKeys } = await import("@/lib/auth-queries");
const { timeEntriesOptions } =
  await import("@/lib/workspaces/queries/time-entries");
const { prefetchPendingApprovals } = await import("./new-invoice-loader");

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("prefetchPendingApprovals", () => {
  test("settles without rejecting when the pending-approval lists fail", async () => {
    const queryClient = new query.QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(rootKeys.role, "owner");

    await prefetchPendingApprovals({
      queryClient,
      userId: USER,
      workspaceId: WORKSPACE,
    });

    // The approver's lists were requested and failed, so the failure path ran.
    expect(
      queryClient.getQueryState(
        timeEntriesOptions(WORKSPACE, USER, { status: "draft" }).queryKey,
      )?.status,
    ).toBe("error");
    expect(requests.some((path) => path.includes("/time-entries/"))).toBe(true);
  });
});
