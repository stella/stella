import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch before the per-test transport.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { GlobalTimer } = await import("@/features/time-timers/global-timer");

const TIME_TIMERS_PATH = "/v1/time-timers";

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await act(async () => {
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

const serve = (timeBilling: boolean) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/v1/workspaces/navigation") {
        return Response.json({
          items: [],
          workspaces: [],
          limit: 100,
          nextCursor: null,
          features: { timeBilling },
        });
      }
      if (url.pathname === TIME_TIMERS_PATH) {
        return Response.json({ items: [], nextCursor: null });
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  return paths;
};

const renderTimer = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        AuthenticatedUserProvider,
        {
          user: {
            activeOrganizationId: "org-a",
            email: "member@example.test",
            id: "member",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          },
        },
        // The fake content renders and requests nothing, so any timers
        // request comes from the eager wrapper alone.
        React.createElement(GlobalTimer, { Content: () => null }),
      ),
    ),
  );
};

test.each([true, false])(
  "the timers request starts without the lazy content when time billing is %p",
  async (timeBilling) => {
    const paths = serve(timeBilling);
    renderTimer();
    await waitFor(() => expect(paths).toContain("/v1/workspaces/navigation"));
    await act(async () => {
      await sleep(20);
    });
    expect(paths.includes(TIME_TIMERS_PATH)).toBe(timeBilling);
  },
);
