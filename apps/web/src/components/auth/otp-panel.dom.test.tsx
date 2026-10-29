import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/sign-in" });
// otp-panel imports the auth client, whose boot prefetch requests the
// session as soon as the module loads. Answer it with no session so the
// request settles instead of staying open until teardown aborts it.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { cleanup, render, within, fireEvent } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { InboxQuickJump, PROVIDERS, PROVIDER_ICON_URLS } =
  await import("./inbox-quick-jump");
const { OTPPanelContent, OTPPanel } = await import("./otp-panel");

const PUBLIC_DIR = `${import.meta.dir}/../../../public`;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const withIntl = (ui: ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      {ui}
    </IntlProvider>,
  );

const noop = () => undefined;

test.each(PROVIDERS.map((provider) => [provider.name, provider] as const))(
  "the %s inbox button shows its self-hosted logo",
  async (name, provider) => {
    const ui = withIntl(
      <InboxQuickJump email={`someone@${provider.domains[0]}`} />,
    );

    const link = ui.getByRole("link", {
      name: messages.auth.openInProvider.replace("{provider}", () => name),
    });
    const iconUrl = PROVIDER_ICON_URLS[name];
    const icon = link.querySelector("img");
    if (iconUrl === null) {
      expect(icon).toBeNull();
      return;
    }
    const src = icon?.getAttribute("src") ?? "";
    expect(src).toBe(iconUrl);
    expect(src).not.toMatch(/^(?:[a-z]+:)?\/\//iu);
    expect(await Bun.file(`${PUBLIC_DIR}${src}`).exists()).toBe(true);
  },
);

test("a custom domain falls back to Gmail and Outlook, both with local logos", () => {
  const ui = withIntl(<InboxQuickJump email="someone@example.com" />);

  const sources = ui
    .getAllByRole("link")
    .map((link) => link.querySelector("img")?.getAttribute("src"));
  expect(sources).toEqual([
    PROVIDER_ICON_URLS.Gmail,
    PROVIDER_ICON_URLS.Outlook,
  ]);
});

test("the resend button reads as one inline run with one space before the email", () => {
  const email = "someone@protonmail.com";
  const ui = withIntl(
    <OTPPanelContent
      email={email}
      isBare
      isOtpComplete={false}
      isOtpPulsing={false}
      onOtpChange={noop}
      onResend={noop}
      onSubmit={noop}
      onUseDifferentEmail={noop}
      otp=""
      resendPending={false}
      verifyPending={false}
    />,
  );

  const button = ui.getByRole("button", { name: /Send code again/u });
  // The button lays out its children as flex items with a gap, so the text
  // and the email must share a single child to keep their spacing.
  const items = Array.from(button.childNodes).filter(
    (node) => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim(),
  );
  expect(items).toHaveLength(1);
  expect(items[0]?.textContent).toBe(`Send code again to ${email}`);
  expect(within(button).getByText(email).textContent).toBe(email);
});

test("OTP verification refreshes the existing session before the two-factor route guard", async () => {
  const { QueryClient, QueryClientProvider } =
    await import("@tanstack/react-query");
  const router = await import("@tanstack/react-router");
  const { sessionOptions } = await import("@/lib/auth-query-options");
  const { MEMBER_SESSION } =
    await import("@/lib/account/auth-session.test-fixtures");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const events: string[] = [];
  let twoFactorPending = false;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("sign-in/email-otp")) {
        events.push("verify");
        twoFactorPending = true;
        return Response.json({ twoFactorRedirect: true });
      }
      if (url.includes("get-session")) {
        events.push("session-read");
        return Response.json(twoFactorPending ? null : MEMBER_SESSION);
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  await client.query({
    ...sessionOptions,
    queryFn: async () => {
      events.push("session-read");
      return twoFactorPending ? null : MEMBER_SESSION;
    },
  });
  events.length = 0;
  const root = router.createRootRoute({ component: router.Outlet });
  const otp = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/otp",
    component: () => (
      <OTPPanel
        email="member@example.test"
        initialOtp="123456"
        redirectTo="/account"
      />
    ),
  });
  const twoFactor = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/two-factor",
    beforeLoad: () => {
      events.push("two-factor");
      if (client.getQueryData(sessionOptions.queryKey)) {
        throw router.redirect({
          to: "/auth/organization",
          search: { redirectTo: "/account" },
        });
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
    routeTree: root.addChildren([otp, twoFactor, organization]),
    history: router.createMemoryHistory({ initialEntries: ["/auth/otp"] }),
    isServer: false,
  });
  try {
    await appRouter.load();
    const ui = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages}>
          <router.RouterProvider router={appRouter} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(client.getQueryData(sessionOptions.queryKey)).toEqual(
      MEMBER_SESSION,
    );
    fireEvent.click(ui.getByRole("button", { name: messages.common.verify }));
    await ui.findByTestId("two-factor-challenge");
    expect(client.getQueryData(sessionOptions.queryKey)).toBeNull();
    expect(events.indexOf("verify")).toBeLessThan(
      events.indexOf("session-read"),
    );
    expect(events.indexOf("session-read")).toBeLessThan(
      events.indexOf("two-factor"),
    );
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
