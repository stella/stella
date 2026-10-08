import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchTotal,
} from "@stll/api-contract/search";

import {
  PUBLIC_LAW_PAGE_REST,
  type PublicLawPageRest,
} from "@/components/public-law-table/public-law-pagination.logic";
import czechMessages from "@/i18n/langs/cs.json";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { useRef, useState } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { PublicLawPager } = await import("./public-law-pager");
const { publicLawNumberedPagerModel } =
  await import("./public-law-pagination.logic");
const { usePublicLawPageArrival } =
  await import("./use-public-law-page-arrival");
const { WORKSPACE_TABLE_SCROLL_SLOT } =
  await import("@/components/workspaces/table/workspace-grid");

afterEach(cleanup);
afterAll(async () => await GlobalRegistrator.unregister());

const PAGE_SIZE = 25;
const DEEPEST_PAGE = 20;
const LONG_RESULTS = {
  type: SEARCH_TOTAL_TYPE.ESTIMATE,
  count: 58_150,
} as const satisfies SearchTotal;

/** A control that changes the page without the reader stepping to one. */
const OTHER_NAVIGATION = "Clear filters";

const rowLabel = (page: number, index: number) =>
  `page ${String(page)} row ${String(index)}`;

type ResultsProps = {
  initialPage: number;
  /** What the search said follows the page on screen. */
  rest: PublicLawPageRest;
  total: SearchTotal;
};

/**
 * The results region as the route draws it: the table's scroller with the
 * page's rows, the pager under it, and a control that changes the page
 * without the reader stepping to one (a filter clears the page). The page
 * links stand in for the route's own `Link`; following one is what moves
 * the URL there.
 */
const Results = ({ initialPage, rest, total }: ResultsProps) => {
  const [page, setPage] = useState(initialPage);
  const regionRef = useRef<HTMLDivElement>(null);
  const requestPage = usePublicLawPageArrival({ regionRef, shownPage: page });
  const model = publicLawNumberedPagerModel({
    deepestPage: DEEPEST_PAGE,
    rest,
    page,
    pageSize: PAGE_SIZE,
    total,
  });

  return (
    <div ref={regionRef}>
      <div data-slot={WORKSPACE_TABLE_SCROLL_SLOT} data-testid="scroller">
        {[0, 1, 2].map((index) => (
          <div
            data-index={index}
            key={rowLabel(page, index)}
            role="row"
            tabIndex={0}
          >
            {rowLabel(page, index)}
          </div>
        ))}
      </div>
      <PublicLawPager
        navigation={{ type: "numbered", model }}
        onPageRequest={(target) => {
          requestPage(target);
          setPage(target);
        }}
        onPageSizeChange={() => undefined}
        pageLink={({ label, page: target }) => (
          <a aria-label={label} href={`#page=${String(target)}`} />
        )}
        pageSize={PAGE_SIZE}
      />
      <button onClick={() => setPage(1)} type="button">
        {OTHER_NAVIGATION}
      </button>
    </div>
  );
};

type MountOptions = { locale: string; localizedMessages: typeof messages };
const ENGLISH: MountOptions = { locale: "en", localizedMessages: messages };

const mount = (
  props: ResultsProps,
  { locale, localizedMessages }: MountOptions = ENGLISH,
) =>
  render(
    <IntlProvider locale={locale} messages={localizedMessages}>
      <FormattingProvider locale={locale} timeZone="UTC">
        <Results {...props} />
      </FormattingProvider>
    </IntlProvider>,
  );

describe("stepping to another page", () => {
  test("Next scrolls the results to the top and focuses the first new row", () => {
    const view = mount({
      initialPage: 2,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });
    const scroller = view.getByTestId("scroller");
    const next = view.getByLabelText(messages.common.next);
    scroller.scrollTop = 400;
    next.focus();
    // The fixture reaches the fault: the reader is deep in the old page, on
    // the pager, when they press Next.
    expect(scroller.scrollTop).toBe(400);
    expect(document.activeElement).toBe(next);

    fireEvent.click(next);

    expect(view.getByTestId("scroller").scrollTop).toBe(0);
    expect(document.activeElement?.textContent).toBe(rowLabel(3, 0));
  });

  test("a jump within reach links to that page and lands on its first row", () => {
    const view = mount({
      initialPage: 6,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });
    const jump = view.getByLabelText("Go to page 8");

    expect(jump.getAttribute("href")).toBe("#page=8");
    fireEvent.click(jump);

    expect(document.activeElement?.textContent).toBe(rowLabel(8, 0));
  });

  test("a page the reader did not step to leaves focus where it is", () => {
    const view = mount({
      initialPage: 4,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });
    const clear = view.getByRole("button", { name: OTHER_NAVIGATION });
    clear.focus();

    fireEvent.click(clear);

    expect(view.getByText(rowLabel(1, 0))).toBeDefined();
    expect(document.activeElement).toBe(clear);
  });
});

describe("the numbered pager", () => {
  test("it is a labelled navigation that marks the current page", () => {
    const view = mount({
      initialPage: 6,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });

    expect(
      view.getByRole("navigation", {
        name: messages.caseLaw.pagination.label,
      }),
    ).toBeDefined();
    expect(
      view.container.querySelector("[aria-current='page']")?.textContent,
    ).toBe("6");
  });

  test("an estimated count is drawn with ~ and read out as approximate", () => {
    const view = mount({
      initialPage: 6,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });

    expect(view.getByText("Page 6 of ~2,326").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(view.getByText("Page 6 of about 2,326").className).toContain(
      "sr-only",
    );
  });

  test("the count reads in the interface's language and number format", () => {
    const view = mount(
      { initialPage: 6, rest: PUBLIC_LAW_PAGE_REST.more, total: LONG_RESULTS },
      { locale: "cs", localizedMessages: czechMessages },
    );

    expect(view.getByText(/^Stránka 6 z ~2\s326$/u)).toBeDefined();
  });

  test("no button leads past the deepest page, and the reader is asked to narrow the search", () => {
    const view = mount({
      initialPage: 6,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });

    expect(
      view.getByLabelText(`Go to page ${String(DEEPEST_PAGE)}`),
    ).toBeDefined();
    expect(
      view.queryByLabelText(`Go to page ${String(DEEPEST_PAGE + 1)}`),
    ).toBeNull();
    expect(
      view.getByText(messages.caseLaw.pagination.refineForMore),
    ).toBeDefined();
  });

  test("on the deepest page Next is disabled", () => {
    const view = mount({
      initialPage: DEEPEST_PAGE,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: LONG_RESULTS,
    });
    const next = view.getByRole("button", { name: messages.common.next });

    expect(next.hasAttribute("disabled")).toBe(true);
    expect(
      view.getByText(messages.caseLaw.pagination.refineForMore),
    ).toBeDefined();
  });

  test("when the search says the results end on this page, no further page is offered", () => {
    // The estimate promises 40 pages of 25; page 3 is the last that exists.
    const view = mount({
      initialPage: 3,
      rest: PUBLIC_LAW_PAGE_REST.end,
      total: { type: SEARCH_TOTAL_TYPE.ESTIMATE, count: 1000 },
    });

    expect(view.queryByLabelText("Go to page 4")).toBeNull();
    expect(
      view.getByRole("button", { name: messages.common.next }),
    ).toHaveProperty("disabled", true);
    expect(view.getByText("Page 3 of 3")).toBeDefined();
    expect(
      view.queryByText(messages.caseLaw.pagination.refineForMore),
    ).toBeNull();
  });

  test("an uncounted result set steps either way without a page count", () => {
    const view = mount({
      initialPage: 3,
      rest: PUBLIC_LAW_PAGE_REST.more,
      total: SEARCH_TOTAL_NOT_COUNTED,
    });

    expect(view.queryByText(/ of /u)).toBeNull();
    expect(view.queryByLabelText("Go to page 1")).toBeNull();
    expect(view.getByLabelText(messages.common.previous)).toBeDefined();
    expect(view.getByLabelText(messages.common.next)).toBeDefined();
  });
});
