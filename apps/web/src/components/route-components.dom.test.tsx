import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { renderToStaticMarkup } = await import("react-dom/server");
const { within } = await import("@testing-library/dom");
const { CancelledError, QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { APIError } = await import("@/lib/errors/api");
const { AuthClientError } = await import("@/lib/errors/auth");
const { DefaultErrorComponent, DefaultNotFoundComponent } =
  await import("./route-components");

afterAll(async () => await unregisterDomEnvironment());

test("not found renders a message and a route back without redirecting", () => {
  const root = createRootRoute();
  const router = createRouter({
    isServer: true,
    history: createMemoryHistory({ initialEntries: ["/time/invoices"] }),
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workspaces" }),
    ]),
  });
  const markup = renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <RouterContextProvider router={router}>
        <DefaultNotFoundComponent />
      </RouterContextProvider>
    </IntlProvider>,
  );
  const container = document.createElement("div");
  // safe-html: markup comes from React renderToStaticMarkup above, which escapes text.
  container.innerHTML = markup;
  const ui = within(container);

  expect(ui.getByRole("heading").textContent).toBe(
    "We could not find what you requested.",
  );
  expect(
    ui
      .getByRole("link", { name: en.auth.invitation.goToWorkspaces })
      .getAttribute("href"),
  ).toBe("/workspaces");
});

const errors = [
  { kind: "cancellation", error: new CancelledError({ revert: true }) },
  { kind: "network", error: new TypeError("Failed to fetch") },
  ...[400, 401, 403, 404, 429, 500, 503].map((status) => ({
    kind: `HTTP ${status}`,
    error: new APIError({ status, message: "Request failed" }),
  })),
  {
    kind: "membership",
    error: new AuthClientError({
      status: 403,
      statusText: "Forbidden",
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      message: "Membership required",
    }),
  },
  { kind: "unknown", error: new Error("Unexpected failure") },
  ...Object.entries(ACTION_ADMISSION_REFUSALS).map(([code, { status }]) => ({
    kind: `admission ${code}`,
    error: new APIError({ code, status, message: "Action refused" }),
  })),
];

for (const { locale, messages } of [
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
]) {
  for (const { kind, error } of errors) {
    test(`global ${kind} fallback has visible text and an action immediately in ${locale}`, () => {
      const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
      });
      const root = createRootRoute();
      const router = createRouter({
        isServer: true,
        history: createMemoryHistory({ initialEntries: ["/law/cases"] }),
        routeTree: root.addChildren([
          createRoute({ getParentRoute: () => root, path: "/law/cases" }),
          createRoute({ getParentRoute: () => root, path: "/workspaces" }),
          createRoute({ getParentRoute: () => root, path: "/auth" }),
        ]),
      });
      const controller = {
        caught: () => undefined,
        routeResolved: () => undefined,
        retryStarted: async () => undefined,
        shown: () => undefined,
        updateInspectorState: () => undefined,
      } satisfies RouteErrorLifecycleController;
      // An error boundary must be useful before effects, automatic retries,
      // or authentication redirects have had a chance to run.
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <IntlProvider
            locale={locale}
            messages={messages}
            onError={(translationError) => {
              throw translationError;
            }}
            timeZone="UTC"
          >
            <RouteErrorLifecycleProvider controller={controller}>
              <RouterContextProvider router={router}>
                <DefaultErrorComponent error={error} reset={() => undefined} />
              </RouterContextProvider>
            </RouteErrorLifecycleProvider>
          </IntlProvider>
        </QueryClientProvider>,
      );
      const container = document.createElement("div");
      // safe-html: markup comes from React renderToStaticMarkup above, which escapes text.
      container.innerHTML = markup;
      const ui = within(container);
      const message = ui.queryByRole("heading") ?? ui.getByRole("status");
      expect(message.textContent.trim().length).toBeGreaterThan(0);
      const actions = [
        ...ui.queryAllByRole("button"),
        ...ui.queryAllByRole("link"),
      ];
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some((action) => action.textContent.trim())).toBe(true);
      client.clear();
    });
  }
}
