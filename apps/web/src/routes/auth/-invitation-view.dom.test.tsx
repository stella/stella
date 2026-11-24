import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { isPanic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { rejectionOf } from "@stll/property-testing/rejection";

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
const { InvitationRefusal } = await import("./-invitation-view");
const { loadInvitationView } = await import("./-invitation-view.logic");

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

const pendingInvitation = (role: string) => ({
  id: "invitation-1",
  organizationId: "organization-1",
  email: "person@example.test",
  role,
  status: "pending",
  inviterId: "user-1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  organizationName: "Harbour Legal",
  organizationSlug: "harbour-legal",
  inviterEmail: "inviter@example.test",
});

test("a pending invitation for a known role is shown", async () => {
  answerInvitationWith(200, pendingInvitation("member"));

  expect(await loadInvitationView("invitation-1")).toMatchObject({
    type: "invitation",
    invitation: { role: "member" },
  });
});

test("a role the app has no words for is a defect, not a sentence", async () => {
  answerInvitationWith(200, pendingInvitation("partner"));

  expect(isPanic(await rejectionOf(loadInvitationView("invitation-1")))).toBe(
    true,
  );
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
      calls.push(input instanceof Request ? input.url : input.toString());
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
  const reported: unknown[] = [];

  reportUnhandledAuthClientError(
    { code, message: "Forbidden", status: 403, statusText: "Forbidden" },
    (error) => {
      reported.push(error);
    },
    "https://api.example.test/api/auth/organization/get-invitation",
  );

  expect(reported).toEqual([]);
});

test("accepting refreshes the session before the destination loads and never reads the consumed invitation again", async () => {
  const { InvitationPage } = await import("./-accept-invitation.page");
  const calls: string[] = [];
  let accepted = false;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const { pathname } = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      calls.push(pathname);
      if (pathname.endsWith("/organization/get-invitation")) {
        // Accepting consumes the invitation, as the server does.
        return await Promise.resolve(
          accepted
            ? json(400, {
                code: "INVITATION_NOT_FOUND",
                message: "Invitation not found",
              })
            : json(200, pendingInvitation("member")),
        );
      }
      if (pathname.endsWith("/organization/accept-invitation")) {
        accepted = true;
        return await Promise.resolve(
          json(200, { invitation: pendingInvitation("member") }),
        );
      }
      return await Promise.resolve(json(200, null));
    },
    { preconnect: () => undefined },
  );

  const root = createRootRoute();
  const invitation = createRoute({
    getParentRoute: () => root,
    path: "/auth/accept-invitation/$invitationId",
    beforeLoad: () => ({ signedInEmail: "person@example.test" }),
    loader: async ({ params }) => await loadInvitationView(params.invitationId),
    component: InvitationPage,
  });
  const workspaces = createRoute({
    getParentRoute: () => root,
    path: "/workspaces",
    loader: () => {
      calls.push("loader /workspaces");
    },
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

  const accept = (await screen.findByText(messages.common.accept)).closest(
    "button",
  );
  if (accept === null) {
    throw new Error("The invitation offers no accept button");
  }
  fireEvent.click(accept);

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/workspaces");
    expect(router.state.status).toBe("idle");
  });
  const acceptedAt = calls.findIndex((path) =>
    path.endsWith("/organization/accept-invitation"),
  );
  expect(acceptedAt).toBeGreaterThan(-1);
  // The destination reads the cached session, so the refresh lands first.
  const refreshedAt = calls.findIndex(
    (path, index) => index > acceptedAt && path.endsWith("/get-session"),
  );
  expect(refreshedAt).toBeGreaterThan(acceptedAt);
  expect(calls.indexOf("loader /workspaces")).toBeGreaterThan(refreshedAt);
  expect(
    calls
      .slice(acceptedAt)
      .filter((path) => path.endsWith("/organization/get-invitation")),
  ).toEqual([]);
});
