import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { AuthCapabilities } from "./sign-in-panel.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/sign-in" });
const originalFetch = globalThis.fetch;
const stubFetch = (body: unknown) =>
  Object.assign(async () => Response.json(body), {
    preconnect: () => undefined,
  });
globalThis.fetch = stubFetch(null);
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { SignInPanel } = await import("./sign-in-panel");

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = stubFetch(null);
});
afterAll(async () => {
  await sleep(0);
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const emailOnly = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: false, microsoft: false },
} satisfies AuthCapabilities;

const mount = async (capabilities: AuthCapabilities) => {
  globalThis.fetch = stubFetch(capabilities);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/sign-in",
    component: () => <SignInPanel redirectTo="/" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/auth/sign-in"] }),
    routeTree: root.addChildren([route]),
    isServer: false,
  });
  await appRouter.load();
  const ui = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <router.RouterProvider router={appRouter} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  return ui;
};

test("offers no password sign-in without the capability", async () => {
  const ui = await mount(emailOnly);

  expect(
    ui.queryByRole("button", { name: messages.auth.usePassword }),
  ).toBeNull();
  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();
});

test("keeps the password form behind a quiet option with the capability", async () => {
  const ui = await mount({ ...emailOnly, reviewPasswordSignIn: true });

  const option = ui.getByRole("button", { name: messages.auth.usePassword });
  expect(option.getAttribute("aria-expanded")).toBe("false");
  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();

  fireEvent.click(option);

  await waitFor(() => ui.getByPlaceholderText(messages.auth.password));
  expect(
    ui.getByRole("button", { name: messages.auth.signInWithPassword }),
  ).toBeDefined();
  expect(
    ui.queryByRole("button", { name: messages.auth.usePassword }),
  ).toBeNull();
});
