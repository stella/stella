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
const { stellaToast } = await import("@stll/ui/toast");
const { cleanup, render, screen, within, fireEvent, waitFor, act } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { sessionOptions } = await import("@/lib/auth-queries");
const { linkedAccountsOptions } = await import("@/lib/account/queries");
const { authCapabilitiesOptions } = await import("@/lib/auth-capabilities");
const { TwoFactorCard } = await import("./two-factor-card");
const { toAPIError } = await import("@/lib/errors/api");
const { toAuthClientError } = await import("@/lib/errors/auth");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer Data, unknown>
    ? Data
    : never;

const signedAt = new Date("2026-01-01T00:00:00Z");
const mount = (emailAvailable: boolean) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(
    sessionOptions.queryKey,
    () =>
      ({
        session: {
          activeOrganizationId: "organization",
          createdAt: signedAt,
          expiresAt: new Date("2027-01-01T00:00:00Z"),
          id: "session",
          token: "token",
          updatedAt: signedAt,
          userId: "user",
        },
        user: {
          createdAt: signedAt,
          email: "member@example.test",
          emailVerified: true,
          id: "user",
          name: "Member",
          timezoneId: "UTC",
          twoFactorEnabled: false,
          updatedAt: signedAt,
        },
      }) satisfies SessionData,
  );
  client.setQueryData(linkedAccountsOptions("user").queryKey, []);
  client.setQueryData(authCapabilitiesOptions.queryKey, {
    emailOtp: emailAvailable,
    localPassword: false,
    reviewPasswordSignIn: false,
    bootstrap: false,
    social: { google: false, microsoft: false },
    transactionalEmail: emailAvailable,
  });
  render(
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
          <TwoFactorCard />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test.each([403, 404, 500])(
  "two-factor email OTP requests retain localized status %i",
  async (status) => {
    const emailAvailable = true;
    const privateMessage = "Private email provider account detail";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => Response.json({ message: privateMessage }, { status }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
    try {
      mount(emailAvailable);
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.settings.account.twoFactor.enable,
          }),
        ),
      );
      const dialog = await screen.findByRole("dialog");
      await act(async () =>
        fireEvent.click(
          within(dialog).getByRole("button", {
            name: messages.settings.account.twoFactor.enable,
          }),
        ),
      );
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(toast.mock.calls.at(0)?.at(0)).toMatchObject({
        title: toAPIError({ status, value: { message: privateMessage } })
          .message,
        type: "error",
      });
      expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
    } finally {
      toast.mockRestore();
      fetch.mockRestore();
    }
  },
);

test.each([400, 403, 500])(
  "two-factor management refusals preserve their status and invalid-code boundary: %i",
  async (status) => {
    const emailAvailable = false;
    const privateMessage = "Private auth provider detail";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () =>
          Response.json(
            { code: "MANAGEMENT_FAILED", message: privateMessage },
            { status },
          ),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
    try {
      mount(emailAvailable);
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.settings.account.twoFactor.enable,
          }),
        ),
      );
      const dialog = await screen.findByRole("dialog");
      await act(async () =>
        fireEvent.click(
          within(dialog).getByRole("button", {
            name: messages.settings.account.twoFactor.enable,
          }),
        ),
      );
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      expect(fetch).toHaveBeenCalledTimes(1);
      const expected =
        status === 400
          ? messages.auth.twoFactor.invalidCode
          : toAuthClientError({
              code: "MANAGEMENT_FAILED",
              message: privateMessage,
              status,
              statusText: "",
            }).message;
      expect(toast.mock.calls.at(0)?.at(0)).toMatchObject({
        title: expected,
        type: "error",
      });
      expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
    } finally {
      toast.mockRestore();
      fetch.mockRestore();
    }
  },
);
