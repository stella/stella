import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  KANBAN_CARD_STICKY_TOP_CLASS,
  KANBAN_CARD_STICKY_TOP_VAR,
  KANBAN_STICKY_TOP_CLASS,
  KANBAN_STICKY_TOP_VAR,
  KanbanCollapsedBandCaption,
  resolveKanbanCardStickyTop,
} from "./sticky-lane";

describe("KANBAN_STICKY_TOP_VAR", () => {
  test("names the property the board publishes and the utility reads", () => {
    expect(KANBAN_STICKY_TOP_VAR).toBe("--kanban-sticky-top");
    // The exported name and the class that consumes it cannot drift: a
    // renamed variable that left the utility behind would stick every lane
    // control at the fallback offset instead, silently.
    expect(KANBAN_STICKY_TOP_CLASS).toBe(`top-(${KANBAN_STICKY_TOP_VAR},0px)`);
  });
});

describe("KANBAN_CARD_STICKY_TOP_VAR", () => {
  test("names the property the cell publishes and the card shell reads", () => {
    expect(KANBAN_CARD_STICKY_TOP_VAR).toBe("--kanban-card-sticky-top");
    expect(KANBAN_CARD_STICKY_TOP_CLASS).toBe(
      `top-(${KANBAN_CARD_STICKY_TOP_VAR},0px)`,
    );
  });
});

describe("resolveKanbanCardStickyTop", () => {
  test("adds the pinned action to the board's own offset", () => {
    expect(resolveKanbanCardStickyTop({ pinnedAbove: 52, rowOffset: 0 })).toBe(
      "calc(var(--kanban-sticky-top, 0px) + 52px)",
    );
  });

  test("subtracts the translation the row is already carrying", () => {
    // A row 608px down asks for its offset in its own translated space, so the
    // browser resolves it to the same place on screen as the first row's.
    expect(
      resolveKanbanCardStickyTop({ pinnedAbove: 52, rowOffset: 608 }),
    ).toBe("calc(var(--kanban-sticky-top, 0px) - 556px)");
  });

  test("keeps the offset a single signed term", () => {
    // `calc(var(--x) + -556px)` parses in no engine: the sign has to be the
    // operator, not part of the value.
    expect(
      resolveKanbanCardStickyTop({ pinnedAbove: 0, rowOffset: 556 }),
    ).not.toContain("+ -");
  });
});

describe("KanbanCollapsedBandCaption", () => {
  const markup = renderToStaticMarkup(
    <KanbanCollapsedBandCaption label="To do" meta="7" />,
  );

  test("sets the band's name vertically over its count", () => {
    expect(markup).toContain(">To do<");
    expect(markup).toContain(">7<");
    expect(markup).toContain("[writing-mode:vertical-rl]");
    expect(markup).toContain('data-kanban-collapsed-band-caption=""');
    // The weight the open caption sets a band's name in, kept through the
    // fold so a narrow slot still reads as the name of a group of columns.
    expect(markup).toContain("font-semibold");
  });

  test("sticks under the board's header without stretching in its slot", () => {
    expect(markup).toContain("sticky");
    expect(markup).toContain(KANBAN_STICKY_TOP_CLASS);
    // A stretched caption fills its slot and can never travel through it.
    expect(markup).toContain("self-start");
  });
});
