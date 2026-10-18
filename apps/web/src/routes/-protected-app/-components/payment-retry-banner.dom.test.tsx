import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_FEATURE_USAGE: "true",
});

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch before the per-test transport.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { organizationAccessOptions } = await import("@/lib/usage-queries");
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
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

const paymentRetry = (endsAt: string) => ({
  paymentRetry: { status: "payment_retry", endsAt },
});

const none = { paymentRetry: { status: "none" } } as const;

const renderBanner = (queryClient: InstanceType<typeof QueryClient>) => {
  if (queryClient.getQueryData(roleOptions.queryKey) === undefined) {
    queryClient.setQueryData(roleOptions.queryKey, "member");
  }
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
      React.createElement(
        FormattingProvider,
        { locale: "en-GB", timeZone: "UTC" },
        React.createElement(PaymentRetryBanner),
      ),
    );
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(IntlProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(BannerForOrganization, {
          organizationId: "org-a",
        }),
      }),
    ),
  );
  return {
    ...view,
    showOrganization: (organizationId: string) =>
      view.rerender(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(IntlProvider, {
            locale: "en",
            messages,
            timeZone: "UTC",
            children: React.createElement(BannerForOrganization, {
              organizationId,
            }),
          }),
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
      const url = input instanceof Request ? input.url : String(input);
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
    await waitFor(() => {
      expect(
        Bun.deepEquals(
          queryClient.getQueryData(
            organizationAccessOptions({ organizationId: "org-b" }).queryKey,
          ),
          none,
        ),
      ).toBe(true);
    });
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
    expect(
      Bun.deepEquals(
        queryClient.getQueryData(
          organizationAccessOptions({ organizationId: "org-b" }).queryKey,
        ),
        none,
      ),
    ).toBe(true);

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
    await waitFor(() => {
      expect(view.getByRole("status").textContent).toContain("Payment issue");
    });
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

test("external members never request organization access", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json(none);
    },
    { preconnect: () => undefined },
  );
  const queryClient = new QueryClient();
  queryClient.setQueryData(roleOptions.queryKey, "external");
  const view = renderBanner(queryClient);
  try {
    await act(async () => {
      await sleep(30);
    });
    expect(requests).toBe(0);
    expect(view.queryByRole("status")).toBeNull();
  } finally {
    view.unmount();
    queryClient.clear();
  }
});

test("access permission refusals are not retried", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json({ code: "forbidden" }, { status: 403 });
    },
    { preconnect: () => undefined },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const view = renderBanner(queryClient);
  try {
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["usage", "access", "org-a"])?.status,
      ).toBe("error"),
    );
    expect(requests).toBe(1);
    expect(view.queryByRole("status")).toBeNull();
  } finally {
    view.unmount();
    queryClient.clear();
  }
});

test("the deadline follows regional formatting independently of the language", async () => {
  const deadline = new Date("2099-10-04T12:00:00Z");
  globalThis.fetch = Object.assign(
    async () => Response.json(paymentRetry(deadline.toISOString())),
    { preconnect: () => undefined },
  );
  const queryClient = new QueryClient();
  const view = renderBanner(queryClient);
  try {
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain("4 October 2099"),
    );
    expect(view.getByRole("status").textContent).not.toContain(
      "October 4, 2099",
    );
  } finally {
    view.unmount();
    queryClient.clear();
  }
});
