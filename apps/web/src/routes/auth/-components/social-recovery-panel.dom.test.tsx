import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/error" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider, useTranslations } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const arabicMessages = (await import("@/i18n/langs/ar.json")).default;
const { SocialRecoveryPanel } = await import("./social-recovery-panel");
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

const defaultHint = { method: "microsoft", provider: "google" } as const;
const SecondFactor = () => {
  const t = useTranslations();
  return <div>{t("auth.twoFactor.title")}</div>;
};

const mount = async (
  locale = "en",
  hint: ComponentProps<typeof SocialRecoveryPanel>["hint"] = defaultHint,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const recovery = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/error",
    component: () => (
      <SocialRecoveryPanel
        error="account_not_linked"
        redirectTo="/chat"
        signedIn={false}
        hint={hint}
      />
    ),
  });
  const twoFactor = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/two-factor",
    component: SecondFactor,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/auth/error"] }),
    routeTree: root.addChildren([recovery, twoFactor]),
    isServer: false,
  });
  await appRouter.load();
  return {
    appRouter,
    ui: render(
      <QueryClientProvider client={client}>
        <IntlProvider
          locale={locale}
          messages={locale === "ar" ? arabicMessages : messages}
        >
          <router.RouterProvider router={appRouter} />
        </IntlProvider>
      </QueryClientProvider>,
    ),
  };
};

const fakeAuth = (signIn: (body: Record<string, unknown>) => Response) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      if (path.endsWith("/sign-in/email-otp")) {
        return signIn(body);
      }
      if (path.endsWith("/get-session")) {
        return Response.json(null);
      }
      return Response.json({ status: true });
    },
    { preconnect: () => undefined },
  );
  return calls;
};
const submitProof = async (ui: ReturnType<typeof render>) => {
  fireEvent.change(ui.getByRole("textbox"), {
    target: { value: "person@example.com" },
  });
  fireEvent.click(
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  await waitFor(() => expect(ui.getByText(/We sent a code/u)).toBeDefined());
  fireEvent.change(ui.getByRole("textbox"), { target: { value: "123456" } });
};

test("connecting requires successful email proof followed by an explicit click", async () => {
  const calls = fakeAuth(() =>
    Response.json({ token: "session", user: { emailVerified: true } }),
  );
  const { ui } = await mount();
  expect(ui.queryByRole("button", { name: "Connect Google" })).toBeNull();
  await submitProof(ui);
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "Connect Google" })).toBeDefined(),
  );
  expect(calls.some(({ path }) => path.endsWith("/link-social"))).toBe(false);
  fireEvent.click(ui.getByRole("button", { name: "Connect Google" }));
  await waitFor(() =>
    expect(
      calls.filter(({ path }) => path.endsWith("/link-social")),
    ).toHaveLength(1),
  );
  expect(
    calls.find(({ path }) => path.endsWith("/link-social"))?.body["provider"],
  ).toBe("google");
});
test("reset confirmation resends the same code with consent only after Continue", async () => {
  const calls = fakeAuth((body) =>
    body["confirmReset"] === true
      ? Response.json({ token: "session" })
      : Response.json(
          {
            code: "confirm_access_reset",
            message: "Confirm",
            providers: ["microsoft", "credential"],
          },
          { status: 409 },
        ),
  );
  const { ui } = await mount();
  await submitProof(ui);
  await waitFor(() =>
    expect(ui.getByText(/Continuing disconnects/u)).toBeDefined(),
  );
  expect(
    calls.filter(({ path }) => path.endsWith("/sign-in/email-otp")),
  ).toHaveLength(1);
  expect(ui.queryByRole("button", { name: "Connect Google" })).toBeNull();
  expect(ui.getByText(`Microsoft, ${messages.auth.password}`)).toBeDefined();
  fireEvent.click(
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "Connect Google" })).toBeDefined(),
  );
  expect(
    calls
      .filter(({ path }) => path.endsWith("/sign-in/email-otp"))
      .map(({ body }) => body),
  ).toEqual([
    { email: "person@example.com", otp: "123456" },
    { email: "person@example.com", otp: "123456", confirmReset: true },
  ]);
});
test("canceling reset sends no confirmed request", async () => {
  const calls = fakeAuth(() =>
    Response.json(
      { code: "confirm_access_reset", providers: ["microsoft"] },
      { status: 409 },
    ),
  );
  const { ui } = await mount();
  await submitProof(ui);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: messages.common.cancel }),
    ).toBeDefined(),
  );
  fireEvent.click(ui.getByRole("button", { name: messages.common.cancel }));
  await waitFor(() =>
    expect(ui.getByRole("textbox").getAttribute("type")).toBe("email"),
  );
  expect(
    calls.filter(({ path }) => path.endsWith("/sign-in/email-otp")),
  ).toHaveLength(1);
  expect(calls.some(({ body }) => body["confirmReset"])).toBe(false);
});
test("a second factor must complete before connecting can be offered", async () => {
  const calls = fakeAuth(() => Response.json({ twoFactorRedirect: true }));
  const { ui, appRouter } = await mount();
  await submitProof(ui);
  await waitFor(() =>
    expect(ui.getByText(messages.auth.twoFactor.title)).toBeDefined(),
  );
  expect(appRouter.state.location.search).toMatchObject({
    linkProvider: "google",
    redirectTo: "/chat",
  });
  expect(calls.some(({ path }) => path.endsWith("/link-social"))).toBe(false);
});
test("Arabic recovery uses translated instructions and an isolated email input", async () => {
  fakeAuth(() => Response.json(null));
  const { ui } = await mount("ar");
  expect(ui.container.textContent).toContain(
    arabicMessages.auth.socialLink.methodHint.replace(
      "<identity>{method}</identity>",
      "Microsoft",
    ),
  );
  expect(ui.getByText("Microsoft").closest("bdi")).not.toBeNull();
  expect(ui.getByRole("textbox").getAttribute("dir")).toBe("ltr");
  expect(
    ui.getByRole("button", { name: arabicMessages.auth.continueWithEmail }),
  ).toBeDefined();
});

test("an invalid code never offers connecting or confirms a reset", async () => {
  const calls = fakeAuth(() =>
    Response.json(
      { code: "INVALID_OTP", message: "Invalid OTP" },
      { status: 400 },
    ),
  );
  const { ui } = await mount();
  await submitProof(ui);
  await waitFor(() =>
    expect(ui.getByRole("textbox").getAttribute("value")).toBe(""),
  );
  expect(ui.queryByRole("button", { name: "Connect Google" })).toBeNull();
  expect(calls.some(({ body }) => body["confirmReset"])).toBe(false);
});

test("a missing method hint shows the generic email proof step", async () => {
  fakeAuth(() => Response.json(null));
  const { ui } = await mount("en", { method: null, provider: null });
  expect(ui.getByText(messages.auth.socialLink.emailProof)).toBeDefined();
  expect(ui.container.textContent).not.toContain("Microsoft");
  expect(ui.queryByRole("button", { name: "Connect Google" })).toBeNull();
});
