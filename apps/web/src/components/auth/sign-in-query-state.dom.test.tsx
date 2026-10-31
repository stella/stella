import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  otpSearchSchema,
  otpSessionNavigation,
} from "@/routes/auth/-otp.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { SIGN_IN_MODE } from "./sign-in-mode";
import type { SignInMode } from "./sign-in-mode";
import type { AuthCapabilities } from "./sign-in-panel.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/sign-in" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { authCapabilitiesOptions } = await import("@/lib/auth-capabilities");
const { SignInPanel } = await import("./sign-in-panel");
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await sleep(0);
  await unregisterDomEnvironment();
});

const capabilities = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: false, microsoft: false, apple: false },
} satisfies AuthCapabilities;

const mount = async (mode: SignInMode = SIGN_IN_MODE.signIn) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/sign-in",
    component: () => <SignInPanel mode={mode} redirectTo="/account" />,
  });
  const otpRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/otp",
    validateSearch: otpSearchSchema,
    beforeLoad: ({ search }) => {
      const navigation = otpSessionNavigation({
        ...search,
        session: "present",
      });
      if (navigation) {
        throw router.redirect(navigation);
      }
    },
    component: () => <div data-testid="otp-challenge" />,
  });
  const organizationRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/organization",
    component: () => <div data-testid="existing-session" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/auth/sign-in"] }),
    routeTree: root.addChildren([route, otpRoute, organizationRoute]),
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
  return { client, ui, appRouter };
};

test("sign-in capability failures offer retry without an invented email sign-in option", async () => {
  const response = Promise.withResolvers<Response>();
  let attempts = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("capabilities")) {
        attempts += 1;
        return attempts === 1 ? response.promise : Response.json(capabilities);
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  const { ui } = await mount();
  await waitFor(() => expect(ui.getByRole("status")).toBeDefined());
  expect(ui.queryByRole("textbox")).toBeNull();
  await act(async () =>
    response.resolve(
      Response.json({ message: "Unavailable" }, { status: 503 }),
    ),
  );
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.queryByRole("textbox")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: messages.common.retry }));
  await waitFor(() => expect(ui.getByRole("textbox")).toBeDefined());
  expect(ui.queryByRole("alert")).toBeNull();
  expect(attempts).toBe(2);
});

test("a capability refetch failure keeps the confirmed sign-in options beside retry", async () => {
  let attempts = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("capabilities")) {
        attempts += 1;
        return attempts === 2
          ? Response.json({ message: "Unavailable" }, { status: 503 })
          : Response.json(capabilities);
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  const { client, ui } = await mount();
  await waitFor(() => expect(ui.getByRole("textbox")).toBeDefined());
  await act(async () => {
    await client.refetchQueries({ queryKey: authCapabilitiesOptions.queryKey });
  });
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.getByRole("textbox")).toBeDefined();
  fireEvent.click(ui.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(client.getQueryState(authCapabilitiesOptions.queryKey)?.status).toBe(
      "success",
    ),
  );
  expect(attempts).toBe(3);
  expect(
    ui.queryAllByRole("alert").map((alert) => alert.textContent),
  ).not.toContain(messages.common.somethingWentWrong);
});

for (const mode of Object.values(SIGN_IN_MODE)) {
  test(`${mode} email entry carries its mode to the OTP route with an existing session`, async () => {
    const sent: unknown[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("capabilities")) {
          return Response.json(capabilities);
        }
        if (url.includes("send-verification-otp")) {
          sent.push(init?.body);
          return Response.json({ success: true });
        }
        return Response.json(null);
      },
      { preconnect: () => undefined },
    );
    const { ui, appRouter } = await mount(mode);
    const email = await ui.findByPlaceholderText(
      messages.auth.emailPlaceholder,
    );
    fireEvent.change(email, { target: { value: "reader@example.test" } });
    fireEvent.click(
      ui.getByRole("button", {
        name: messages.auth.continueWithEmail,
      }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    await ui.findByTestId(
      mode === SIGN_IN_MODE.reauthenticate
        ? "otp-challenge"
        : "existing-session",
    );
    if (mode === SIGN_IN_MODE.reauthenticate) {
      expect(appRouter.state.location.search).toEqual({
        email: "reader@example.test",
        redirectTo: "/account",
        mode: SIGN_IN_MODE.reauthenticate,
      });
    }
  });
}
