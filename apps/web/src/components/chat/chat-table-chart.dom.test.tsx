import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { TableChartResponse } from "@stll/api-contract/table-chart";

import arabic from "@/i18n/langs/ar.json";
import english from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { Streamdown } = await import("streamdown");
const { ChatTableChart } = await import("./chat-table-chart");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const markdown =
  "| Month | Hours |\n| --- | --- |\n| **June** | 12 |\n| July | 8 |";
const ready = {
  status: "ready",
  plan: {
    kind: "bar",
    columns: [
      { index: 0, role: "label" },
      { index: 1, role: "y" },
    ],
    sort: "none",
    title: "Hours",
  },
} satisfies TableChartResponse;

const mount = (
  requestPlan: () => Promise<TableChartResponse>,
  locale = "en",
) => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider
        locale={locale}
        messages={locale.startsWith("ar") ? arabic : english}
        timeZone="UTC"
      >
        <FormattingProvider locale={locale} timeZone="UTC">
          <Streamdown
            mode="static"
            components={{
              table: (props) => (
                <ChatTableChart
                  {...props}
                  cacheScope={["org-a", "user-a"]}
                  requestPlan={requestPlan}
                />
              ),
            }}
          >
            {markdown}
          </Streamdown>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("requests no decision until clicked, switches kind, returns to table and reuses the session decision", async () => {
  let calls = 0;
  const view = mount(async () => {
    calls += 1;
    return ready;
  });
  expect(view.getByRole("table")).toBeDefined();
  expect(
    view
      .getByRole("button", { name: "Show as chart" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(calls).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Show as chart" }));
  const image = await view.findByRole("img", { name: "Hours" });
  expect(image.getAttribute("aria-describedby")).toBeTruthy();
  expect(
    view.getByText(/Values shown: 2/u, { selector: "figcaption bdi" }),
  ).toBeDefined();
  expect(view.container.textContent).toContain("June: 12");
  expect(view.queryByRole("table")).toBeNull();
  expect(
    view.container.querySelectorAll('[data-slot="chart-bar"]').length,
  ).toBe(2);
  fireEvent.click(view.getByRole("button", { name: "Line" }));
  expect(
    view.container.querySelectorAll('[data-slot="chart-line"]').length,
  ).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Pie" }));
  expect(
    view.container.querySelectorAll('[data-slot="chart-slice"]').length,
  ).toBe(2);
  expect(view.queryByRole("button", { name: "Scatter" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show table" }));
  expect(view.getByRole("table")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Show as chart" }));
  await view.findByRole("img", { name: "Hours" });
  expect(calls).toBe(1);
});

test.each(["unavailable", "failure"])(
  "%s keeps the table and reports a neutral outcome",
  async (outcome) => {
    let calls = 0;
    const view = mount(async () => {
      calls += 1;
      if (outcome === "failure") {
        throw new TypeError("Synthetic chart failure");
      }
      return { status: "unavailable" };
    });
    fireEvent.click(view.getByRole("button", { name: "Show as chart" }));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        english.chat.tableChart.unavailable,
      ),
    );
    expect(view.getByRole("table")).toBeDefined();
    expect(view.queryByRole("img")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show as chart" }));
    await waitFor(() => expect(view.getByRole("status")).toBeDefined());
    expect(calls).toBe(1);
  },
);

test("Arabic controls and chart summary use translated text and local number formatting", async () => {
  const view = mount(async () => ready, "ar-u-nu-arab");
  fireEvent.click(
    view.getByRole("button", { name: arabic.chat.tableChart.showChart }),
  );
  await view.findByRole("img", { name: "Hours" });
  expect(view.container.textContent).toContain("١٢");
  expect(
    view.getByRole("button", {
      name: arabic.workspaces.views.timeline.showTable,
    }),
  ).toBeDefined();
});
