import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanCardShell } from "./card-shell";
import { KANBAN_CARD_STICKY_TOP_CLASS } from "./sticky-lane";

// Static markup carries no layout; where the pinned row actually comes to rest
// is the browser suite's job. These pin the markup that suite depends on.

describe("KanbanCardShell sticky header", () => {
  test("renders no pinned row by default", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell>
        <p>body</p>
      </KanbanCardShell>,
    );

    expect(markup).not.toContain("data-kanban-card-sticky-header");
    expect(markup).not.toContain("sticky");
  });

  test("leads the card with the identity row", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell stickyHeader={<span>ACME-1</span>}>
        <p>body</p>
      </KanbanCardShell>,
    );

    expect(markup).toContain('data-kanban-card-sticky-header=""');
    expect(markup).toContain(KANBAN_CARD_STICKY_TOP_CLASS);
    // The card passes behind the row: its own surface, over the card's own
    // divider weight.
    expect(markup).toContain("bg-card sticky");
    expect(markup).toContain("border-b");
    expect(markup.indexOf("ACME-1")).toBeLessThan(markup.indexOf("body"));
  });

  test("takes no stacking layer the actions overlay would have to outrank", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        stickyHeader={<span>ACME-1</span>}
      >
        <p>body</p>
      </KanbanCardShell>,
    );

    // Callers anchor `actions` to the same corner with no layer of its own, so
    // a layer here would paint the row over the trigger and swallow its clicks.
    // Positioned already beats the card's flow content; tree order does the
    // rest, and the row renders first.
    expect(markup).not.toContain("z-[");
    expect(markup.indexOf("ACME-1")).toBeLessThan(markup.indexOf("More"));
  });

  test("keeps the row ahead of the children a card that opens renders", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        onOpen={() => undefined}
        stickyHeader={<span>ACME-1</span>}
      >
        <p>body</p>
      </KanbanCardShell>,
    );

    expect(markup).toContain('role="button"');
    expect(markup.indexOf("ACME-1")).toBeLessThan(markup.indexOf("body"));
    expect(markup.indexOf("body")).toBeLessThan(markup.indexOf("More"));
  });

  test("never clips the card that bounds the pinned row", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell stickyHeader={<span>ACME-1</span>}>
        <p>body</p>
      </KanbanCardShell>,
    );

    // Clipping anywhere between the row and the board's scroll container ends
    // the pinning outright, so the shell's own chrome must not introduce any.
    expect(markup).not.toContain("overflow-hidden");
    expect(markup).not.toContain("overflow-clip");
  });
});
