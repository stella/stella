import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { withFakeTimers } from "@stll/test-kit";

import messages from "@/i18n/langs/en.json";

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
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { GlobalTimerContent } =
  await import("@/features/time-timers/global-timer-content");

const TIME_TIMERS_PATH = "/v1/time-timers";

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await unregisterDomEnvironment();
});

const serveNoTimers = () => {
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
          features: { timeBilling: true },
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

test("the header timer does not re-render while no timer runs", async () => {
  const paths = serveNoTimers();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  let commits = 0;
  await withFakeTimers(async (timers) => {
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          IntlProvider,
          { locale: "en", messages, timeZone: "UTC" },
          React.createElement(
            FormattingProvider,
            { locale: "en-GB", timeZone: "UTC" },
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
              React.createElement(
                React.Profiler,
                {
                  id: "global-timer",
                  onRender: () => {
                    commits += 1;
                  },
                },
                React.createElement(GlobalTimerContent),
              ),
            ),
          ),
        ),
      ),
    );
    // Let the timers and navigation queries settle without moving the clock.
    for (let round = 0; round < 10; round += 1) {
      await act(async () => {
        await timers.advance(0);
      });
    }
    expect(paths).toContain(TIME_TIMERS_PATH);
    expect(queryClient.isFetching()).toBe(0);
    const settled = commits;

    // Several ticks of the one-second clock the elapsed time used to run on.
    await act(async () => {
      await timers.advance(3000);
    });

    expect(commits).toBe(settled);
  });
});
