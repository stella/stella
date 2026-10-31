import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { TimeEntryReport } from "@stll/api-contract/time-entry-report";

import arabic from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/time/report" });
const { act } = await import("react");
const { cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
const {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ReportLayout } = await import("./report-page");
const metrics = {
  recordedMinutes: 180,
  billableMinutes: 120,
  pendingEntries: 2,
  activeMembers: 1,
  unbilledValues: [{ currency: "EUR", value: 24_000 }],
};
const data = {
  rows: [
    {
      rowId: "anna",
      rowName: "Anna",
      memberId: "anna",
      matterId: null,
      parentId: null,
      bucket: "2026-10-26",
      minutes: 180,
    },
    {
      rowId: "anna:matter",
      rowName: "Harbour lease",
      memberId: "anna",
      matterId: "00000000-0000-4000-8000-000000000001",
      parentId: "anna",
      bucket: "2026-10-26",
      minutes: 180,
    },
  ],
  summary: {
    current: metrics,
    previous: {
      ...metrics,
      billableMinutes: 60,
      unbilledValues: [{ currency: "EUR", value: 12_000 }],
    },
  },
} satisfies TimeEntryReport;
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = async (
  locale: "en" | "ar" = "en",
  value: TimeEntryReport = data,
) => {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/time/report",
    component: () => (
      <IntlProvider
        locale={locale}
        messages={locale === "ar" ? arabic : messages}
        timeZone="UTC"
      >
        <FormattingProvider
          locale={locale === "ar" ? "ar-u-nu-arab" : "en-GB"}
          timeZone="UTC"
        >
          <ReportLayout
            data={value}
            filter={{
              from: "2026-10-26",
              to: "2026-11-01",
              groupBy: "member",
              bucket: "day",
            }}
            period="week"
            onChange={() => undefined}
          />
        </FormattingProvider>
      </IntlProvider>
    ),
  });
  const approvals = createRoute({
    getParentRoute: () => root,
    path: "/time/approvals",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([route, approvals]),
    history: createMemoryHistory({ initialEntries: ["/time/report"] }),
  });
  await act(async () => {
    await router.load();
    render(<RouterProvider router={router} />);
  });
};

test("shows summary tiles, totals and member/matter cell links without counting expanded time twice", async () => {
  await mount();
  expect(
    screen.getByRole("heading", { name: "Team time report" }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Billable hours" })).getByText(
      "2",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Billable share" }).textContent,
  ).toContain("66.7%");
  const table = screen.getByRole("table");
  expect(
    within(table).getByRole("row", { name: /^Total/u }).textContent,
  ).toContain("3");
  const anna = within(table).getByRole("row", { name: /Anna/u });
  expect(
    within(anna).getAllByRole("link").at(0)?.getAttribute("href"),
  ).toContain("date=2026-10-26");
  expect(
    within(anna).getAllByRole("link").at(0)?.getAttribute("href"),
  ).toContain("member=anna");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Expand Anna" })),
  );
  const matter = within(table).getByRole("row", { name: /Harbour lease/u });
  expect(
    within(matter).getAllByRole("link").at(0)?.getAttribute("href"),
  ).toContain("matter=00000000-0000-4000-8000-000000000001");
  expect(
    within(table).getByRole("row", { name: /^Total/u }).textContent,
  ).toContain("3");
});

test("does not render amounts when billing visibility hides them", async () => {
  await mount("en", {
    ...data,
    summary: {
      current: { ...metrics, unbilledValues: null },
      previous: { ...metrics, unbilledValues: null },
    },
  });
  expect(
    screen.queryByRole("region", { name: "Unbilled billable value" }),
  ).toBeNull();
  expect(screen.getByRole("region", { name: "Billable hours" })).toBeTruthy();
});

test("renders the Arabic catalog and localized numeric cells", async () => {
  await mount("ar");
  expect(
    screen.getByRole("heading", { name: arabic.billing.timeReport.title }),
  ).toBeTruthy();
  expect(screen.getByRole("table").textContent).toContain("٣");
});
