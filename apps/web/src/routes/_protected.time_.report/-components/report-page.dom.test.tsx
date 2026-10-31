import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { TimeEntryReport } from "@stll/api-contract/time-entry-report";
import { TIME_ENTRY_REPORT_INTERNAL_ROW_ID } from "@stll/api-contract/time-entry-report";

import arabic from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { ReportFilter } from "./report-query";

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

const WEEK = {
  from: "2026-10-26",
  to: "2026-11-01",
  groupBy: "member",
  bucket: "day",
} satisfies ReportFilter;
const mount = async (
  locale: "en" | "ar" = "en",
  value: TimeEntryReport | "too-large" = data,
  filter: ReportFilter = WEEK,
) => {
  const result =
    value === "too-large"
      ? ({ type: "too-large" } as const)
      : ({ type: "report", report: value } as const);
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
            data={result}
            filter={filter}
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

test("labels the billable share change in percentage points", async () => {
  await mount();
  expect(
    screen.getByRole("region", { name: "Billable share" }).textContent,
  ).toContain("Change in percentage points: 33.33");
  expect(
    screen.getByRole("region", { name: "Billable hours" }).textContent,
  ).toContain("Change: 1");
});

test("names internal work and links only cells the approvals week can scope", async () => {
  const internal = {
    rowId: TIME_ENTRY_REPORT_INTERNAL_ROW_ID,
    rowName: null,
    memberId: null,
    matterId: null,
    parentId: null,
    bucket: "2026-10-01",
    minutes: 60,
  };
  const client = {
    ...internal,
    rowId: "00000000-0000-4000-8000-000000000002",
    rowName: "Harbour client",
  };
  await mount(
    "en",
    { ...data, rows: [client, internal] },
    {
      ...WEEK,
      groupBy: "client",
      bucket: "month",
    },
  );
  const table = screen.getByRole("table");
  expect(within(table).getByRole("row", { name: /^Internal/u })).toBeTruthy();
  expect(within(table).queryAllByRole("link")).toEqual([]);
});

test("offers the CSV instead of a grid too large to render", async () => {
  const rows = Array.from({ length: 2900 }, (_, index) => ({
    rowId: `member-${index}`,
    rowName: `Member ${index}`,
    memberId: `member-${index}`,
    matterId: null,
    parentId: null,
    bucket: "2026-10-26",
    minutes: 60,
  }));
  await mount("en", { ...data, rows });
  const table = screen.getByRole("table");
  expect(table.textContent).toContain(messages.billing.timeReport.tooManyCells);
  expect(within(table).queryByRole("row", { name: /Member 1/u })).toBeNull();
  expect(
    screen.getByRole("button", { name: messages.workspaces.views.exportCsv }),
  ).toBeTruthy();
});

test("lists an expanded member's matters right under that member", async () => {
  const member = (id: string, name: string) => ({
    rowId: id,
    rowName: name,
    memberId: id,
    matterId: null,
    parentId: null,
    bucket: "2026-10-26",
    minutes: 60,
  });
  const matter = (parent: string, name: string, matterId: string) => ({
    rowId: `${parent}:${matterId}`,
    rowName: name,
    memberId: parent,
    matterId,
    parentId: parent,
    bucket: "2026-10-26",
    minutes: 60,
  });
  // The API sends every member row before any matter row.
  await mount("en", {
    ...data,
    rows: [
      member("ben", "Ben"),
      member("anna", "Anna"),
      matter("ben", "Merger", "00000000-0000-4000-8000-000000000002"),
      matter("anna", "Harbour lease", "00000000-0000-4000-8000-000000000001"),
    ],
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Expand Anna" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Expand Ben" })),
  );
  const names = within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1, -1)
    .map((row) => row.textContent ?? "");
  expect(
    names.map((text) => text.match(/Anna|Harbour lease|Ben|Merger/u)?.[0]),
  ).toEqual(["Anna", "Harbour lease", "Ben", "Merger"]);
});

test("explains a range too large to load instead of failing the page", async () => {
  await mount("en", "too-large");
  expect(screen.getByRole("status").textContent).toBe(
    messages.billing.timeReport.tooLargeToLoad,
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Team time report" }),
  ).toBeTruthy();
});
