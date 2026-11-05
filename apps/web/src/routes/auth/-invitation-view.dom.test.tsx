import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { createWebTestEnvironment } from "../../../tests/environment.test-fixtures";

GlobalRegistrator.register({
  url: "https://app.example.test/auth/accept-invitation/invitation-1",
});
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");

const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { reportUnhandledAuthClientError } =
  await import("@/lib/account/auth-code-report");
const { InvitationRefusal, loadInvitationView } =
  await import("./-invitation-view");

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** Answers every request the way the invitation endpoint answers this one. */
const answerInvitationWith = (status: number, body: unknown) => {
  globalThis.fetch = Object.assign(
    async () =>
      await Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    { preconnect: () => undefined },
  );
};

const renderRefusal = async (
  code:
    | "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION"
    | "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
) => {
  const root = createRootRoute();
  const invitation = createRoute({
    getParentRoute: () => root,
    path: "/auth/accept-invitation/$invitationId",
    component: () => (
      <InvitationRefusal code={code} email="person@example.test" />
    ),
  });
  const workspaces = createRoute({
    getParentRoute: () => root,
    path: "/workspaces",
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ["/auth/accept-invitation/invitation-1"],
    }),
    routeTree: root.addChildren([invitation, workspaces]),
  });
  await router.load();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test.each([
  ["YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"],
  ["EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION"],
] as const)("a 403 %s is a refusal, not a missing page", async (code) => {
  answerInvitationWith(403, { code, message: "Forbidden" });

  expect(await loadInvitationView("invitation-1")).toEqual({
    type: "refused",
    code,
  });
});

test("an invitation that does not exist stays not found", async () => {
  answerInvitationWith(404, {
    code: "INVITATION_NOT_FOUND",
    message: "Invitation not found",
  });

  expect(await loadInvitationView("invitation-1")).toEqual({ type: "missing" });
});

test("the wrong account sees whose session this is and can sign out", async () => {
  await renderRefusal("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION");

  await screen.findByText(messages.errors.apiCodes.invitationOtherRecipient);
  screen.getByText(
    "You are signed in as person@example.test. Sign out, then sign in with the address the invitation was sent to.",
  );
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return await Promise.resolve(Response.json({ success: true }));
    },
    { preconnect: () => undefined },
  );

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() => {
    expect(calls.some((url) => url.includes("/sign-out"))).toBe(true);
  });
});

test("an unverified account is told how to verify its address", async () => {
  await renderRefusal("EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION");

  await screen.findByText(messages.errors.apiCodes.invitationEmailUnverified);
  screen.getByText(
    "To verify person@example.test, sign out, then sign in with a one-time code sent to that address.",
  );
});

test.each([
  ["YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"],
  ["EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION"],
])("%s is an expected answer, not a reported defect", (code) => {
  const report = mock();

  reportUnhandledAuthClientError(
    { code, message: "Forbidden", status: 403, statusText: "Forbidden" },
    report,
    "https://api.example.test/api/auth/organization/get-invitation",
  );

  expect(report).not.toHaveBeenCalled();
});
