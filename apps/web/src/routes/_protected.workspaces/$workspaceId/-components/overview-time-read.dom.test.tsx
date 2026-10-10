import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { getFormatter } = await import("@/i18n/i18n-store");
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider, QueryObserver, useQuery } =
  await import("@tanstack/react-query");
const { useQueryView } = await import("@/lib/use-query-view");
const { OverviewTimeRead, OverviewTimeTrend } =
  await import("./overview-time-read");

const TEST_UNIT_LABEL = "hours";

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const site of ["current-week", "previous-week", "team-week"]) {
  test(`${site}: a failed read exposes retry rather than zero hours`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let calls = 0;
    const readSummary = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Summary unavailable");
      }
      return { totalMinutes: 120, viewerTotalMinutes: 120 };
    };
    const Read = () => {
      const view = useQueryView(
        useQuery({ queryKey: [site], queryFn: readSummary }),
      );
      return (
        <OverviewTimeRead view={view}>
          {(summary) => (
            <span>
              {getFormatter().number(
                (site === "team-week"
                  ? summary.viewerTotalMinutes
                  : summary.totalMinutes) / 60,
              )}{" "}
              {TEST_UNIT_LABEL}
            </span>
          )}
        </OverviewTimeRead>
      );
    };
    const mounted = render(
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <QueryClientProvider client={client}>
          <Read />
        </QueryClientProvider>
      </IntlProvider>,
    );
    expect(mounted.queryByText("0 hours")).toBeNull();
    await act(async () => {
      await client.refetchQueries({ queryKey: [site] });
    });
    expect(await mounted.findByRole("alert")).toBeDefined();
    expect(mounted.queryByText("0 hours")).toBeNull();
    fireEvent.click(
      mounted.getByRole("button", { name: englishMessages.common.retry }),
    );
    expect(await mounted.findByText("2 hours")).toBeDefined();
    expect(mounted.queryByRole("alert")).toBeNull();
    mounted.unmount();
    client.clear();
  });

  for (const totalMinutes of [0, 180]) {
    test(`${site}: failed refetch retains ${totalMinutes} cached minutes with a notice`, async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      client.setQueryData([site], {
        totalMinutes,
        viewerTotalMinutes: totalMinutes,
      });
      const Read = () => {
        const view = useQueryView(
          useQuery({
            queryKey: [site],
            initialData: { totalMinutes, viewerTotalMinutes: totalMinutes },
            queryFn: async () => {
              throw new Error("Summary unavailable");
            },
          }),
        );
        return (
          <OverviewTimeRead view={view}>
            {(summary) => (
              <span>
                {getFormatter().number(
                  (site === "team-week"
                    ? summary.viewerTotalMinutes
                    : summary.totalMinutes) / 60,
                )}{" "}
                {TEST_UNIT_LABEL}
              </span>
            )}
          </OverviewTimeRead>
        );
      };
      const mounted = render(
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <QueryClientProvider client={client}>
            <Read />
          </QueryClientProvider>
        </IntlProvider>,
      );
      await act(async () => {
        await client.refetchQueries({ queryKey: [site] });
      });
      expect(await mounted.findByRole("alert")).toBeDefined();
      expect(mounted.getByText(`${totalMinutes / 60} hours`)).toBeDefined();
      expect(
        mounted.getByRole("button", { name: englishMessages.common.retry }),
      ).toBeDefined();
      mounted.unmount();
      client.clear();
    });
  }
}

test("pending and successful empty summaries expose distinct states", () => {
  const pending = render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <OverviewTimeRead view={{ type: "pending" }}>
        {() => "0 hours"}
      </OverviewTimeRead>
    </IntlProvider>,
  );
  expect(pending.getByRole("status").getAttribute("aria-label")).toBe(
    englishMessages.common.loading,
  );
  expect(pending.queryByText("0 hours")).toBeNull();
  pending.unmount();
  const empty = render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <OverviewTimeRead view={{ type: "empty" }}>
        {() => "0 hours"}
      </OverviewTimeRead>
    </IntlProvider>,
  );
  expect(empty.getByText(englishMessages.common.noResults)).toBeDefined();
  expect(empty.queryByRole("status")).toBeNull();
});

for (const view of [
  { type: "pending" },
  { type: "empty" },
  {
    type: "error",
    error: new Error("Summary unavailable"),
  },
  {
    type: "items",
    items: { totalMinutes: 60 },
    refetchError: new Error("Summary unavailable"),
  },
] as const) {
  test(`the optional ${view.type} trend leaves the personal read's single error state`, () => {
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["overview-time-trend", view.type],
      queryFn: async () => ({ totalMinutes: 60 }),
      enabled: false,
    });
    const retry = observer.getCurrentResult().refetch;
    const screen = render(
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <OverviewTimeRead
          view={{
            type: "error",
            error: new Error("Summary unavailable"),
            retry,
          }}
        >
          {() => "Current hours"}
        </OverviewTimeRead>
        <OverviewTimeTrend
          currentHours={null}
          view={
            view.type === "pending" || view.type === "empty"
              ? view
              : { ...view, retry }
          }
        />
      </IntlProvider>,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(englishMessages.common.noResults)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    screen.unmount();
    observer.destroy();
    client.clear();
  });
}

test("the optional trend displays the change between available weekly summaries", () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["overview-time-trend", "available"],
    queryFn: async () => ({ totalMinutes: 60 }),
    enabled: false,
  });
  const screen = render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <OverviewTimeTrend
        currentHours={2}
        view={{
          type: "items",
          items: { totalMinutes: 60 },
          retry: observer.getCurrentResult().refetch,
        }}
      />
    </IntlProvider>,
  );
  expect(screen.getByText("▲ 100%")).toBeDefined();
  screen.unmount();
  observer.destroy();
  client.clear();
});
