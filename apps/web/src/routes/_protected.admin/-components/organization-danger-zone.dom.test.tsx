import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json" with { type: "json" };
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/general" });
const originalFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { OrganizationDangerZone } = await import("./organization-danger-zone");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { organizationAuditExportLatestOptions } =
  await import("@/lib/organization/audit-export-queries");

const user = {
  id: "owner-fixture",
  activeOrganizationId: "organization-fixture",
  email: "owner@example.test",
  name: "Owner",
  image: null,
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

type AuditArchive = Awaited<
  ReturnType<
    NonNullable<
      ReturnType<typeof organizationAuditExportLatestOptions>["queryFn"]
    >
  >
>;

const CURRENT_ARCHIVE = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  expiresAt: "2099-01-01T00:00:00.000Z",
  coversCurrentTrail: true,
} as const satisfies AuditArchive;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = (
  isOwner = true,
  afterSuccess?: () => Promise<void>,
  auditArchive: AuditArchive = CURRENT_ARCHIVE,
) => {
  let completed = 0;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(
    organizationAuditExportLatestOptions("organization-fixture", user.id)
      .queryKey,
    auditArchive,
  );
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={user}>
            <OrganizationDangerZone
              organizationId="organization-fixture"
              organizationName="Novak Legal"
              isOwner={isOwner}
              onSuccess={async () => {
                completed += 1;
                await afterSuccess?.();
              }}
            />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return () => completed;
};

const refuse = (code: string, message: string) => {
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json(
        { code, message },
        { status: 400, statusText: "Bad Request" },
      );
    },
  );
  return requests;
};

test("the last-owner leave refusal explains the refusal and keeps membership", async () => {
  const explanation = "You cannot leave the organization as the last owner.";
  const requests = refuse(
    "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
    explanation,
  );
  const completed = mount();
  fireEvent.click(
    screen.getByRole("button", { name: messages.admin.leaveOrganization }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      messages.admin.leaveRefusedOnlyOwner,
    ),
  );
  expect(requests).toEqual([
    {
      path: "/api/auth/organization/leave",
      body: { organizationId: "organization-fixture" },
    },
  ]);
  expect(completed()).toBe(0);
});

test("renewing-subscription deletion stays open and offers plan and usage recovery", async () => {
  const explanation =
    "Cancel your renewing subscription before deleting the organization.";
  const requests = refuse("organization_subscription_renews", explanation);
  const completed = mount();
  fireEvent.click(
    screen.getByRole("button", { name: messages.admin.deleteOrganization }),
  );
  const dialog = await screen.findByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", {
    name: messages.admin.deleteOrganization,
  });
  expect(confirm).toHaveProperty("disabled", true);
  expect(requests).toHaveLength(0);
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Novak Legal" },
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      messages.admin.deleteRefusedSubscription,
    ),
  );
  expect(
    within(dialog)
      .getByRole("link", { name: messages.admin.planAndUsage })
      .getAttribute("href"),
  ).toBe("/admin/usage");
  expect(requests).toEqual([
    {
      path: "/api/auth/organization/delete",
      body: { organizationId: "organization-fixture" },
    },
  ]);
  expect(screen.getByRole("alertdialog")).toBeDefined();
  expect(completed()).toBe(0);
});

test("administrators can leave but cannot open organization deletion", () => {
  mount(false);
  expect(
    screen.getByRole("button", { name: messages.admin.leaveOrganization }),
  ).toBeDefined();
  expect(
    screen.queryByRole("button", { name: messages.admin.deleteOrganization }),
  ).toBeNull();
});

test("successful leave remains completed when destination refresh fails", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {
    requests += 1;
    return Response.json({});
  });
  const completed = mount(true, async () => {
    throw new Error("Destination refresh failed");
  });
  const leave = screen.getByRole("button", {
    name: messages.admin.leaveOrganization,
  });
  fireEvent.click(leave);
  await waitFor(() =>
    expect(
      screen.getByText(messages.admin.organizationLeft).getAttribute("role"),
    ).toBe("status"),
  );
  expect(completed()).toBe(1);
  expect(leave).toHaveProperty("disabled", true);
  fireEvent.click(leave);
  expect(requests).toBe(1);
});

test("deletion waits for a current activity log archive the owner can request", async () => {
  const requests: { method: string; path: string }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return Response.json({ id: CURRENT_ARCHIVE.id, status: "requested" });
    },
  );
  mount(true, undefined, null);
  expect(
    screen.getByRole("button", { name: messages.admin.deleteOrganization }),
  ).toHaveProperty("disabled", true);

  fireEvent.click(
    screen.getByRole("button", { name: messages.admin.auditArchiveRequest }),
  );

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      messages.admin.auditArchiveWorking,
    ),
  );
  expect(requests).toContainEqual({
    method: "POST",
    path: "/v1/organizations/audit-export",
  });
  expect(
    screen.getByRole("button", { name: messages.admin.deleteOrganization }),
  ).toHaveProperty("disabled", true);
});

test("an outdated archive offers a new export and keeps deletion closed", () => {
  mount(true, undefined, { ...CURRENT_ARCHIVE, coversCurrentTrail: false });
  expect(screen.getByRole("status").textContent).toBe(
    messages.admin.auditArchiveOutdated,
  );
  expect(
    screen.getByRole("button", { name: messages.admin.auditArchiveRequestNew }),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: messages.admin.deleteOrganization }),
  ).toHaveProperty("disabled", true);
});

test("a deletion refused for an outdated archive says to export again", async () => {
  refuse("organization_audit_export_stale", "Export the activity log again.");
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: messages.admin.deleteOrganization }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Novak Legal" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: messages.admin.deleteOrganization,
    }),
  );
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      messages.admin.auditArchiveOutdated,
    ),
  );
});
