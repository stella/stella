import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_FEATURE_USAGE: "true",
});

const originalFetch = globalThis.fetch;
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { PaymentRetryBanner } =
  await import("@/routes/-protected-app/-components/payment-retry-banner");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
  await GlobalRegistrator.unregister();
});

const paymentRetry = (endsAt: string) => ({
  paymentRetry: { status: "payment_retry", endsAt },
});

const none = { paymentRetry: { status: "none" } };

const renderBanner = (queryClient: InstanceType<typeof QueryClient>) => {
  const BannerForOrganization = ({
    organizationId,
  }: {
    organizationId: string;
  }) =>
    React.createElement(
      AuthenticatedUserProvider,
      {
        user: {
          activeOrganizationId: organizationId,
          email: "member@example.test",
          id: "member",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        },
      },
      React.createElement(PaymentRetryBanner),
    );
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        IntlProvider,
        { locale: "en", messages, timeZone: "UTC" },
        React.createElement(BannerForOrganization, { organizationId: "org-a" }),
      ),
    ),
  );
  return {
    ...view,
    showOrganization: (organizationId: string) =>
      view.rerender(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            IntlProvider,
            { locale: "en", messages, timeZone: "UTC" },
            React.createElement(BannerForOrganization, { organizationId }),
          ),
        ),
      ),
  };
};

test("a delayed access response stays in its organization cache and retry copy expires locally", async () => {
  const oldResponse = Promise.withResolvers<Response>();
  const newResponse = Promise.withResolvers<Response>();
  let accessRequestCount = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/v1/usage/access");
      const signal = input instanceof Request ? input.signal : init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      accessRequestCount += 1;
      if (accessRequestCount === 1) {
        return await oldResponse.promise;
      }
      return await newResponse.promise;
    },
    { preconnect: () => undefined },
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderBanner(queryClient);
  try {
    await waitFor(() => expect(accessRequestCount).toBe(1));
    await act(async () => {
      view.showOrganization("org-b");
    });
    await waitFor(() => expect(accessRequestCount).toBe(2));
    const queryKeys = queryClient
      .getQueryCache()
      .findAll()
      .map(({ queryKey }) => queryKey);
    expect(queryKeys).toContainEqual(["usage", "access", "org-a"]);
    expect(queryKeys).toContainEqual(["usage", "access", "org-b"]);

    newResponse.resolve(Response.json(none));
    await waitFor(() =>
      expect(queryClient.getQueryData(["usage", "access", "org-b"])).toEqual(
        none,
      ),
    );
    await act(async () => {
      oldResponse.resolve(
        Response.json(
          paymentRetry(
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          ),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByRole("status")).toBeNull();
    expect(queryClient.getQueryData(["usage", "access", "org-b"])).toEqual(
      none,
    );

    const expiryResponse = Promise.withResolvers<Response>();
    globalThis.fetch = Object.assign(
      async () => (await expiryResponse.promise).clone(),
      { preconnect: () => undefined },
    );
    await act(async () => {
      view.showOrganization("org-c");
    });
    const endsAt = new Date(Date.now() + 1500).toISOString();
    expiryResponse.resolve(Response.json(paymentRetry(endsAt)));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain("Payment issue"),
    );
    await waitFor(() => expect(view.queryByRole("status")).toBeNull(), {
      timeout: 3000,
    });
  } finally {
    oldResponse.resolve(Response.json(none));
    newResponse.resolve(Response.json(none));
    view.unmount();
    queryClient.clear();
  }
});
