import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { OrganizationRoleName } from "@stll/auth-model";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json" with { type: "json" };

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/members",
});
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { rootKeys } = await import("@/lib/auth-query-options");
const { MemberBillingAccessCell } =
  await import("./member-billing-access-cell");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const ASSOCIATE_ROLE = "member" satisfies OrganizationRoleName;

const mount = (timeBilling: boolean) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(rootKeys.role, "owner");
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MemberBillingAccessCell
          memberId="member_associate"
          role={ASSOCIATE_ROLE}
          billingAccess={false}
          timeBilling={timeBilling}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("billing access is editable when the organization has time billing", () => {
  mount(true);
  expect(
    screen.getByRole("switch", {
      name: messages.organization.members.billingAccess,
    }),
  ).toBeTruthy();
});

test("billing access is not offered when the organization lacks time billing", () => {
  const { container } = mount(false);
  expect(screen.queryByRole("switch")).toBeNull();
  expect(container.textContent).toBe("");
});
