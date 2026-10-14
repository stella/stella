import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DecisionFilterPopover } = await import("./decision-filter-popover");
const { default: messages } = await import("@/i18n/langs/en.json");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const renderFilter = (court?: string) => {
  const selected: unknown[] = [];
  const rendered = render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en-US" timeZone="UTC">
        <DecisionFilterPopover
          activeFilterCount={court === undefined ? 0 : 1}
          dateRange={{}}
          facets={{
            courtTiers: [
              {
                tier: "other",
                courts: Array.from({ length: 12 }, (_, index) => ({
                  value: `Court ${index + 1}`,
                  count: 10,
                })),
              },
            ],
            year: [],
            decisionType: [],
            language: [],
            source: [],
          }}
          selection={{
            court,
            lang: undefined,
            sourceId: undefined,
            type: undefined,
          }}
          onDateRangeChange={() => {}}
          onSelect={(key, value) => {
            selected.push({ key, value });
          }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  fireEvent.click(rendered.getByRole("button", { name: /^Filters/u }));
  return { ...rendered, selected };
};

test("the web court list retains collapsed tiers, row limits and show-all without an inner search or scroll box", () => {
  const view = renderFilter();
  const tier = view.getByRole("button", { name: "Other courts" });
  expect(tier.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.queryByRole("searchbox")).toBeNull();
  const courtSection = tier.closest("section");
  expect(courtSection).not.toBeNull();
  expect(
    courtSection?.querySelector('[data-slot="scroll-area-viewport"]'),
  ).toBeNull();
  fireEvent.click(tier);
  const list = view.getByRole("list", { name: "Other courts" });
  expect(within(list).getAllByRole("radio")).toHaveLength(8);
  fireEvent.click(view.getByRole("button", { name: "Show all" }));
  expect(within(list).getAllByRole("radio")).toHaveLength(12);
  fireEvent.click(within(list).getByRole("radio", { name: /^Court 12\b/u }));
  expect(view.selected).toEqual([{ key: "court", value: "Court 12" }]);
});

test("a selected court opens its collapsed tier and stays pinned beyond the row limit", () => {
  const view = renderFilter("Court 12");
  expect(
    view
      .getByRole("button", { name: "Other courts" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  const list = view.getByRole("list", { name: "Other courts" });
  expect(within(list).getAllByRole("radio")).toHaveLength(9);
  const selected = within(list).getByRole("radio", { name: /^Court 12\b/u });
  expect(selected.matches(":checked")).toBe(true);
  fireEvent.click(selected);
  expect(view.selected).toEqual([{ key: "court", value: undefined }]);
});
