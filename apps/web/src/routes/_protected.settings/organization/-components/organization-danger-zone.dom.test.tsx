import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json" with { type: "json" };
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/general",
});
const originalFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { OrganizationDangerZone } = await import("./organization-danger-zone");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = (isOwner = true, afterSuccess?: () => Promise<void>) => {
  let completed = 0;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <OrganizationDangerZone
          organizationId="organization-fixture"
          organizationName="Novak Legal"
          isOwner={isOwner}
          onSuccess={async () => {
            completed += 1;
            await afterSuccess?.();
          }}
        />
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
  ).toBe("/settings/organization/usage");
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
    expect(screen.getByRole("status").textContent).toBe(
      messages.admin.organizationLeft,
    ),
  );
  expect(completed()).toBe(1);
  expect(leave).toHaveProperty("disabled", true);
  fireEvent.click(leave);
  expect(requests).toBe(1);
});
