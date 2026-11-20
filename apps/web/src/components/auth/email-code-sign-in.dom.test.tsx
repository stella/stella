import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { EmailDeliveryStatus } from "@stll/api-contract/email-delivery";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

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
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { otpSearchSchema } = await import("@/routes/auth/-otp.logic");
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

// Requests a code for `email` from the sign-in step, the server answering
// with `delivery`, and resolves the code step's search once it opens.
const requestCode = async (
  email: string,
  delivery: EmailDeliveryStatus | undefined,
) => {
  globalThis.fetch = stubFetch(emailOnly);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const signIn = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/sign-in",
    component: () => <SignInPanel redirectTo="/account" />,
  });
  const otp = router.createRoute({
    getParentRoute: () => root,
    path: "/auth/otp",
    validateSearch: otpSearchSchema,
    component: () => <div data-testid="code-step" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/auth/sign-in"] }),
    routeTree: root.addChildren([signIn, otp]),
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
  await ui.findByRole("heading", { name: messages.auth.signIn });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/email-otp/send-verification-otp")) {
        return Response.json(
          delivery === undefined
            ? { success: true }
            : { success: true, emailDelivery: delivery },
        );
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );

  fireEvent.change(ui.getByPlaceholderText(messages.auth.emailPlaceholder), {
    target: { value: email },
  });
  fireEvent.click(
    ui.getByRole("button", { name: messages.auth.continueWithEmail }),
  );
  await ui.findByTestId("code-step");
  return appRouter.state.location.search;
};

test("a code request for an address whose mail recently failed carries the reason to the code step", async () => {
  expect(
    await requestCode("new.member@example.test", {
      type: "failed",
      reason: "tls_required",
    }),
  ).toMatchObject({
    email: "new.member@example.test",
    deliveryFailure: "tls_required",
  });
});

test.each([
  ["no failure is recorded", { type: "none_recorded" } as const],
  ["the server could not read it", { type: "unknown" } as const],
  ["the server sent no status", undefined],
])("the code step opens without a reason when %s", async (_, delivery) => {
  const search = await requestCode("member@example.test", delivery);

  expect(search).toMatchObject({ email: "member@example.test" });
  expect(search).not.toHaveProperty("deliveryFailure");
});
