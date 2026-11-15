import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { AUTH_SIGN_IN_CODE_UNAVAILABLE_ERROR_CODE } from "@stll/auth-model";
import { sleep } from "@stll/concurrency/sleep";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { SignInMode } from "./sign-in-mode";
import type {
  AuthCapabilities,
  SignInEntryMethod,
} from "./sign-in-panel.logic";

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
const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { sessionOptions } = await import("@/lib/auth-query-options");
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { SIGN_IN_MODE } = await import("./sign-in-mode");
const { SignInPanel } = await import("./sign-in-panel");
const { SIGN_IN_ENTRY_METHOD } = await import("./sign-in-panel.logic");

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
  await unregisterDomEnvironment();
});

const emailOnly = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: false, microsoft: false, apple: false },
} satisfies AuthCapabilities;

type MountOptions = {
  mode?: SignInMode;
  events?: string[];
  entryMethod?: SignInEntryMethod;
};

const mount = async (
  capabilities: AuthCapabilities,
  { mode = SIGN_IN_MODE.signIn, events = [], entryMethod }: MountOptions = {},
) => {
  globalThis.fetch = stubFetch(capabilities);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/sign-in",
    component: () => (
      <SignInPanel
        entryMethod={entryMethod}
        mode={mode}
        redirectTo="/account"
      />
    ),
  });
  const twoFactor = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/two-factor",
    beforeLoad: () => {
      events.push("challenge");
      if (client.getQueryData(sessionOptions.queryKey)) {
        throw router.redirect({ to: "/auth/organization" });
      }
    },
    component: () => <div data-testid="two-factor-challenge" />,
  });
  const organization = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/organization",
    component: () => <div data-testid="existing-session" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/auth/sign-in"] }),
    routeTree: root.addChildren([route, twoFactor, organization]),
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
  // The panel renders once the capabilities have loaded.
  await ui.findByRole("heading", { name: messages.auth.signIn });
  return { client, ui, appRouter };
};

test("offers no password sign-in without the capability", async () => {
  const { ui } = await mount(emailOnly);

  expect(
    ui.queryByRole("button", { name: messages.auth.usePassword }),
  ).toBeNull();
  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();
});

test("swaps the email step for the password form, carrying the typed address", async () => {
  const { ui } = await mount({ ...emailOnly, reviewPasswordSignIn: true });

  const option = ui.getByRole("button", { name: messages.auth.usePassword });
  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();
  fireEvent.change(ui.getByPlaceholderText(messages.auth.emailPlaceholder), {
    target: { value: "review@example.test" },
  });

  fireEvent.click(option);

  const passwordField = await ui.findByPlaceholderText(messages.auth.password);
  expect(
    ui.getByRole("button", { name: messages.auth.signInWithPassword }),
  ).toBeDefined();
  // One form on the page: the email step and its link are gone.
  for (const name of [
    messages.auth.usePassword,
    messages.auth.continueWithEmail,
  ]) {
    expect(ui.queryByRole("button", { name })).toBeNull();
  }
  const emailFields = ui.getAllByPlaceholderText(
    messages.auth.emailPlaceholder,
  );
  expect(emailFields).toHaveLength(1);
  expect(emailFields.at(0)?.getAttribute("value")).toBe("review@example.test");
  expect(document.activeElement).toBe(passwordField);

  fireEvent.click(ui.getByRole("button", { name: messages.auth.useEmailCode }));

  await waitFor(() =>
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();
});

test("opens on the password form when a link asks for it", async () => {
  const { ui } = await mount(
    { ...emailOnly, reviewPasswordSignIn: true },
    { entryMethod: SIGN_IN_ENTRY_METHOD.password },
  );

  expect(ui.getByPlaceholderText(messages.auth.password)).toBeDefined();
  expect(
    ui.queryByRole("button", { name: messages.auth.continueWithEmail }),
  ).toBeNull();
  expect(
    ui.getByRole("button", { name: messages.auth.useEmailCode }),
  ).toBeDefined();
});

test("ignores a link asking for the password form without the capability", async () => {
  const { ui } = await mount(emailOnly, {
    entryMethod: SIGN_IN_ENTRY_METHOD.password,
  });

  expect(ui.queryByPlaceholderText(messages.auth.password)).toBeNull();
  expect(
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  ).toBeDefined();
});

test("shows the password form alone when the page has no email step", async () => {
  const { ui } = await mount({
    ...emailOnly,
    emailOtp: false,
    reviewPasswordSignIn: true,
  });

  expect(ui.getByPlaceholderText(messages.auth.password)).toBeDefined();
  expect(
    ui.queryByRole("button", { name: messages.auth.useEmailCode }),
  ).toBeNull();
});

test("swaps the email-code form for the password form when the server names a password account", async () => {
  const { ui } = await mount({ ...emailOnly, reviewPasswordSignIn: true });
  const requested: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/email-otp/send-verification-otp")) {
        requested.push(url);
        return Response.json(
          {
            code: AUTH_SIGN_IN_CODE_UNAVAILABLE_ERROR_CODE,
            message: "This account signs in with a password.",
          },
          { status: 409 },
        );
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );

  fireEvent.change(ui.getByPlaceholderText(messages.auth.emailPlaceholder), {
    target: { value: "review@example.test" },
  });
  fireEvent.click(
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );

  const passwordField = await ui.findByPlaceholderText(messages.auth.password);
  expect(requested).toHaveLength(1);
  expect(
    ui.queryByRole("button", { name: messages.auth.continueWithEmail }),
  ).toBeNull();
  const emailFields = ui.getAllByPlaceholderText(
    messages.auth.emailPlaceholder,
  );
  expect(emailFields).toHaveLength(1);
  expect(emailFields.at(0)?.getAttribute("value")).toBe("review@example.test");
  expect(document.activeElement).toBe(passwordField);
});

test("password two-factor sign-in clears the old session before the challenge guard", async () => {
  const events: string[] = [];
  let pendingTwoFactor = false;
  const { client, ui, appRouter } = await mount(
    {
      ...emailOnly,
      localPassword: true,
    },
    { mode: SIGN_IN_MODE.reauthenticate, events },
  );
  await client.query({
    ...sessionOptions,
    queryFn: async () => {
      events.push("session-read");
      return pendingTwoFactor ? null : MEMBER_SESSION;
    },
  });
  events.length = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/sign-in/email")) {
        events.push("password-sign-in");
        pendingTwoFactor = true;
        return Response.json({ twoFactorRedirect: true });
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );

  const passwordSubmit = ui.getByRole("button", {
    name: messages.auth.signInWithPassword,
  });
  const passwordForm = passwordSubmit.closest("form");
  if (passwordForm === null) {
    throw new Error("Password sign-in button must belong to its form");
  }
  const passwordFields = within(passwordForm);
  fireEvent.change(
    passwordFields.getByPlaceholderText(messages.auth.emailPlaceholder),
    {
      target: { value: "member@example.test" },
    },
  );
  fireEvent.change(
    passwordFields.getByPlaceholderText(messages.auth.password),
    { target: { value: "correct horse battery staple" } },
  );
  fireEvent.click(passwordSubmit);

  await ui.findByTestId("two-factor-challenge");
  expect(client.getQueryData(sessionOptions.queryKey)).toBeNull();
  expect(events.indexOf("password-sign-in")).toBeLessThan(
    events.indexOf("session-read"),
  );
  expect(events.indexOf("session-read")).toBeLessThan(
    events.indexOf("challenge"),
  );
  expect(appRouter.state.location.pathname).toBe("/auth/two-factor");
});
