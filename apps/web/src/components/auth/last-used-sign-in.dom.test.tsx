import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

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
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { SignInPanel } = await import("./sign-in-panel");

const LAST_USED_COOKIE = "better-auth.last_used_login_method";
const cookieDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(document),
  "cookie",
);
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = stubFetch(null);
  if (cookieDescriptor) {
    Object.defineProperty(document, "cookie", cookieDescriptor);
  }
});
afterAll(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

// The server sets this cookie after a sign-in; the page only reads it.
const browserCookie = (read: () => string) => {
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: read,
    set: () => undefined,
  });
};

const capabilities = {
  emailOtp: true,
  localPassword: true,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: false, microsoft: false },
} satisfies AuthCapabilities;

const mount = async () => {
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
  const emailButton = await waitFor(() =>
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  const passwordButton = ui.getByRole("button", {
    name: messages.auth.signInWithPassword,
  });
  return { ui, emailButton, passwordButton };
};

const isFilled = (button: HTMLElement) =>
  button.classList.contains("bg-primary");

const describedByBadge = (button: HTMLElement, badge: HTMLElement) =>
  badge.id !== "" && button.getAttribute("aria-describedby") === badge.id;

test("the last-used method is the only filled action and carries the badge", async () => {
  browserCookie(() => `theme=dark; ${LAST_USED_COOKIE}=email`);
  const { ui, emailButton, passwordButton } = await mount();

  expect(isFilled(passwordButton)).toBe(true);
  const badge = ui.getByText(messages.auth.lastUsed);
  expect(describedByBadge(passwordButton, badge)).toBe(true);
  expect(isFilled(emailButton)).toBe(false);
  expect(emailButton.hasAttribute("aria-describedby")).toBe(false);
});

test("an email-code sign-in marks the email action", async () => {
  browserCookie(() => `${LAST_USED_COOKIE}=email-otp`);
  const { ui, emailButton, passwordButton } = await mount();

  expect(isFilled(emailButton)).toBe(true);
  expect(
    describedByBadge(emailButton, ui.getByText(messages.auth.lastUsed)),
  ).toBe(true);
  expect(isFilled(passwordButton)).toBe(false);
});

test.each([
  ["no stored method", null],
  ["an unknown method", "passkey"],
  ["a method this page does not offer", "google"],
])("%s leaves the default emphasis and no badge", async (_label, stored) => {
  browserCookie(() => (stored === null ? "" : `${LAST_USED_COOKIE}=${stored}`));
  const { ui, emailButton, passwordButton } = await mount();

  expect(isFilled(emailButton)).toBe(true);
  expect(isFilled(passwordButton)).toBe(true);
  expect(ui.queryByText(messages.auth.lastUsed)).toBeNull();
});

test("blocked cookie storage renders the page without a highlight", async () => {
  browserCookie(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  const { ui, emailButton } = await mount();

  expect(isFilled(emailButton)).toBe(true);
  expect(ui.queryByText(messages.auth.lastUsed)).toBeNull();
});
