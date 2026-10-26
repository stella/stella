import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { BLOCKS, CARDS, EIGHTH, NINTH, selected, TENTH } =
  await import("./margin-citation-filter.fixture");
const { MarginCitationFilterBar, useMarginCitationFilter } =
  await import("./margin-citation-filter");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

type MarginApi = ReturnType<typeof useMarginCitationFilter>;

type HarnessProps = {
  landingParagraphId?: string | undefined;
  /** Handed the filter on every render, as the reader's toolbar holds it. */
  onRender: (margin: MarginApi) => void;
};

/**
 * The reader's two halves as the workspace joins them: a click in the text
 * focuses a paragraph, and the margin lists what the filter leaves.
 */
const Harness = ({ landingParagraphId, onRender }: HarnessProps) => {
  const margin = useMarginCitationFilter({
    blocks: BLOCKS,
    cards: CARDS,
    landingKey: "decision",
    landingParagraphId,
  });
  onRender(margin);
  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- mirrors the workspace's text column, whose keyboard path is each paragraph's permalink */}
      <main onClick={(event) => margin.focusParagraphAt(event.target)}>
        {BLOCKS.map((block) => (
          <p data-anchor={block.anchorId} id={block.anchorId} key={block.id}>
            <a href={`#${block.anchorId}`}>¶</a>
            {block.plainText}
          </p>
        ))}
      </main>
      <aside aria-label="Margin">
        <MarginCitationFilterBar
          count={margin.visibleCards.length}
          filter={margin.filter}
          onShowAll={margin.showAll}
          paragraphNumber={margin.paragraphNumber}
        />
        <ul>
          {margin.visibleCards.map((card) => (
            <li key={card.id}>
              {card.citations.at(0)?.payload.provisionLabel}
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
};

const renderReader = (landingParagraphId?: string) => {
  const renders: MarginApi[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Harness
        landingParagraphId={landingParagraphId}
        onRender={(margin) => {
          renders.push(margin);
        }}
      />
    </IntlProvider>,
  );
  const margin = within(view.getByRole("complementary", { name: "Margin" }));
  const listed = () =>
    margin.queryAllByRole("listitem").map((item) => item.textContent);
  const latest = () => renders.at(-1) ?? panic("The reader never rendered");
  return { listed, margin, renders, latest, view };
};

describe("the margin's citation filter", () => {
  test("focusing a paragraph lists only what it cites, and Show all restores every card", () => {
    const { listed, margin, view } = renderReader();
    expect(listed()).toEqual(["§ 72", "§ 257", "§ 87"]);
    expect(margin.queryByRole("group")).toBeNull();

    fireEvent.click(view.getByText(NINTH));
    expect(listed()).toEqual(["§ 87"]);
    const bar = margin.getByRole("group", {
      name: messages.caseLaw.marginFilter.label,
    });
    expect(bar.textContent).toContain("1 provision cited in ¶9");

    const showAll = within(bar).getByRole("button", {
      name: messages.common.showAll,
    });
    // A real button: in the tab order and focusable without a pointer.
    expect(showAll.tabIndex).toBe(0);
    showAll.focus();
    expect(showAll.ownerDocument.activeElement).toBe(showAll);
    fireEvent.click(showAll);
    expect(listed()).toEqual(["§ 72", "§ 257", "§ 87"]);
    expect(margin.queryByRole("group")).toBeNull();
  });

  test("the paragraph's permalink focuses it, as Enter on the link does", () => {
    const { listed, view } = renderReader();
    const eighth = view.container.querySelector('[data-anchor="p-8"]');
    if (!(eighth instanceof HTMLElement)) {
      return panic("No eighth paragraph");
    }
    fireEvent.click(within(eighth).getByRole("link", { name: "¶" }));
    expect(listed()).toEqual(["§ 72", "§ 257"]);
  });

  test("a paragraph the address lands on starts focused", () => {
    const { listed, margin } = renderReader("p-9");
    expect(listed()).toEqual(["§ 87"]);
    expect(margin.getByRole("group").textContent).toContain("¶9");
  });

  test("a paragraph citing nothing says so beside the way back", () => {
    const { listed, margin, view } = renderReader();
    fireEvent.click(view.getByText(TENTH));
    expect(listed()).toEqual([]);
    const bar = margin.getByRole("group");
    expect(bar.textContent).toContain("No provisions cited in ¶10");
    fireEvent.click(
      within(bar).getByRole("button", { name: messages.common.showAll }),
    );
    expect(listed()).toEqual(["§ 72", "§ 257", "§ 87"]);
  });

  test("a selection narrows to what it cites and, once cleared, gives the paragraph back", () => {
    const { latest, listed, margin, view } = renderReader();
    fireEvent.click(view.getByText(EIGHTH));
    expect(listed()).toEqual(["§ 72", "§ 257"]);

    const start = EIGHTH.indexOf("§ 257");
    act(() => latest().selectSpans([selected("p-8", start, EIGHTH.length)]));
    expect(listed()).toEqual(["§ 257"]);
    expect(margin.getByRole("group").textContent).toContain(
      "1 provision cited in the selection",
    );

    act(() => latest().selectSpans([]));
    expect(listed()).toEqual(["§ 72", "§ 257"]);
    expect(margin.getByRole("group").textContent).toContain("¶8");
  });

  test("a selection that moves over the same citations does not redraw the margin", () => {
    const { latest, listed, renders } = renderReader();
    const start = EIGHTH.indexOf("§ 72");
    act(() => latest().selectSpans([selected("p-8", start, start + 2)]));
    expect(listed()).toEqual(["§ 72"]);
    const settled = renders.length;
    for (let end = start + 3; end < EIGHTH.indexOf("§ 257"); end += 1) {
      act(() => latest().selectSpans([selected("p-8", start, end)]));
    }
    expect(renders).toHaveLength(settled);
    act(() => latest().selectSpans([selected("p-8", start, EIGHTH.length)]));
    expect(renders.length).toBeGreaterThan(settled);
    expect(listed()).toEqual(["§ 72", "§ 257"]);
  });
});
