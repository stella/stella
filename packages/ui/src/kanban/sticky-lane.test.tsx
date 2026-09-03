import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  KANBAN_STICKY_TOP_CLASS,
  KANBAN_STICKY_TOP_VAR,
  KanbanCollapsedBandCaption,
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

describe("KanbanCollapsedBandCaption", () => {
  const markup = renderToStaticMarkup(
    <KanbanCollapsedBandCaption label="To do" meta="7" />,
  );

  test("sets the band's name vertically over its count", () => {
    expect(markup).toContain(">To do<");
    expect(markup).toContain(">7<");
    expect(markup).toContain("[writing-mode:vertical-rl]");
    expect(markup).toContain('data-kanban-collapsed-band-caption=""');
  });

  test("sticks under the board's header without stretching in its slot", () => {
    expect(markup).toContain("sticky");
    expect(markup).toContain(KANBAN_STICKY_TOP_CLASS);
    // A stretched caption fills its slot and can never travel through it.
    expect(markup).toContain("self-start");
  });
});
