import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag } from "@tanstack/react-query";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/account/security",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: originalFetch.preconnect,
});
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { linkedAccountsOptions } = await import("@/lib/account/queries");
const { authCapabilitiesOptions } = await import("@/lib/auth-capabilities");
const { SignInMethods } = await import("./sign-in-methods");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

type LinkedAccountsData =
  ReturnType<typeof linkedAccountsOptions>["queryKey"] extends DataTag<
    unknown,
    infer Data,
    unknown
  >
    ? Data
    : never;

const capabilities = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: true, microsoft: false },
  transactionalEmail: true,
};

const mount = (accounts: LinkedAccountsData, social = capabilities.social) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(linkedAccountsOptions("user").queryKey, accounts);
  client.setQueryData(authCapabilitiesOptions.queryKey, {
    ...capabilities,
    social,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization",
            email: "member@example.test",
            id: "user",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <SignInMethods />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, view };
};

const linkedGoogleAccount = {
  id: "google-account",
  accountId: "google-account",
  providerId: "google",
  userId: "user",
  scopes: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies LinkedAccountsData[number];
const linkedMicrosoftAccount = {
  ...linkedGoogleAccount,
  id: "microsoft-account",
  accountId: "microsoft-account",
  providerId: "microsoft",
} satisfies LinkedAccountsData[number];

const watchRequests = (remainingAccounts: LinkedAccountsData = []) => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : undefined;
        let requestUrl: string;
        if (input instanceof Request) {
          requestUrl = input.url;
        } else if (input instanceof URL) {
          requestUrl = input.href;
        } else {
          requestUrl = input;
        }
        const path = new URL(requestUrl, window.location.origin).pathname;
        let rawBody = "";
        if (typeof init?.body === "string") {
          rawBody = init.body;
        } else if (request) {
          rawBody = await request.clone().text();
        }
        const body = rawBody ? JSON.parse(rawBody) : {};
        requests.push({ path, body });
        if (path.endsWith("/list-accounts")) {
          return Response.json(remainingAccounts);
        }
        return Response.json({ status: true, url: null, redirect: false });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  return { fetch, requests };
};

test("shows linked methods and prevents disconnecting the last one", () => {
  mount([linkedGoogleAccount]);

  expect(screen.getByText("Google")).toBeDefined();
  expect(
    screen.getByText(messages.settings.account.signInMethods.emailCode),
  ).toBeDefined();
  expect(
    screen.getByText(messages.settings.account.signInMethods.lastMethod),
  ).toBeDefined();
  expect(
    screen
      .getByRole("button", { name: messages.common.disconnect })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("connects only a configured provider and sends its provider id", async () => {
  const { fetch, requests } = watchRequests();
  try {
    mount([]);
    expect(screen.getByText("Google")).toBeDefined();
    expect(screen.queryByText("Microsoft")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: messages.common.connect }),
    );
    await waitFor(() =>
      expect(requests.some(({ path }) => path.endsWith("/link-social"))).toBe(
        true,
      ),
    );
    expect(
      requests.find(({ path }) => path.endsWith("/link-social"))?.body,
    ).toMatchObject({ provider: "google" });
  } finally {
    fetch.mockRestore();
  }
});

test("requires a fresh email code before unlinking a connected account", async () => {
  const { fetch, requests } = watchRequests([linkedMicrosoftAccount]);
  try {
    mount([linkedGoogleAccount, linkedMicrosoftAccount]);
    const googleItem = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent.includes("Google"));
    expect(googleItem).toBeDefined();
    if (!googleItem) {
      throw new Error("Google linked account row was not rendered");
    }
    fireEvent.click(
      within(googleItem).getByRole("button", {
        name: messages.common.disconnect,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: messages.settings.account.sendOtpCode,
      }),
    );
    await waitFor(() =>
      expect(
        requests.some((request) =>
          request.path.endsWith("/sign-in-methods/send-otp"),
        ),
      ).toBe(true),
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", {
        name: messages.settings.account.enterOtp,
      }),
      { target: { value: "123456" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: messages.common.disconnect,
      }),
    );
    await waitFor(() =>
      expect(
        requests.some(({ path }) => path.endsWith("/unlink-account")),
      ).toBe(true),
    );

    expect(
      requests.filter(({ path }) => path.endsWith("/sign-in-methods/send-otp")),
    ).toHaveLength(1);
    expect(
      requests.find(({ path }) => path.endsWith("/unlink-account"))?.body,
    ).toMatchObject({ accountId: "google-account", otp: "123456" });
    expect(
      requests.findIndex(({ path }) =>
        path.endsWith("/sign-in-methods/send-otp"),
      ),
    ).toBeLessThan(
      requests.findIndex(({ path }) => path.endsWith("/unlink-account")),
    );
  } finally {
    fetch.mockRestore();
  }
});

test("a failed account refresh does not report a committed unlink as failed", async () => {
  const { fetch, requests } = watchRequests([linkedMicrosoftAccount]);
  const { client } = mount([linkedGoogleAccount, linkedMicrosoftAccount]);
  const invalidation = spyOn(client, "invalidateQueries").mockRejectedValueOnce(
    new Error("Account refresh failed"),
  );
  try {
    const googleItem = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent.includes("Google"));
    expect(googleItem).toBeDefined();
    if (!googleItem) {
      throw new Error("Google linked account row was not rendered");
    }
    fireEvent.click(
      within(googleItem).getByRole("button", {
        name: messages.common.disconnect,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: messages.settings.account.sendOtpCode,
      }),
    );
    const codeInput = await within(dialog).findByRole("textbox", {
      name: messages.settings.account.enterOtp,
    });
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: messages.common.disconnect }),
    );

    await waitFor(() =>
      expect(client.getMutationCache().getAll().at(-1)?.state.status).toBe(
        "success",
      ),
    );
    expect(invalidation).toHaveBeenCalledTimes(1);
    expect(
      requests.filter(({ path }) => path.endsWith("/unlink-account")),
    ).toHaveLength(1);
    expect(client.getQueryData(linkedAccountsOptions("user").queryKey)).toEqual(
      [linkedMicrosoftAccount],
    );
    await waitFor(() => {
      const popup = screen.queryByRole("dialog", { hidden: true });
      expect(popup === null || Object.hasOwn(popup.dataset, "closed")).toBe(
        true,
      );
    });
  } finally {
    invalidation.mockRestore();
    fetch.mockRestore();
  }
});
