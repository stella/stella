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
    // divider weight. `bg-card` alone would let a consumer define the surface
    // with an alpha channel and read the held-back cards straight through it,
    // so the card colour goes down as a layer over the opaque page ground.
    expect(markup).toContain("bg-background");
    expect(markup).toContain(
      "bg-[linear-gradient(var(--color-card),var(--color-card))]",
    );
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

  test("leaves an always-visible actions overlay exactly where the caller put it", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell actions={<button type="button">More</button>}>
        <p>body</p>
      </KanbanCardShell>,
    );

    // The default is the behaviour every existing board relies on: the shell
    // adds no wrapper, so a caller's own anchoring still decides the corner.
    expect(markup).not.toContain("data-kanban-card-actions");
    expect(markup).not.toContain("opacity-0");
  });

  test("reveals hover actions on hover, focus, an open menu, and coarse pointers", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        actionsVisibility="hover"
      >
        <p>body</p>
      </KanbanCardShell>,
    );
    const wrapper =
      /<div[^>]*data-kanban-card-actions="hover"[^>]*>/u.exec(markup)?.[0] ??
      "";

    expect(wrapper).toContain("opacity-0");
    expect(wrapper).toContain("group-hover/card:opacity-100");
    // The hover group the wrapper answers to is on the shell's own wrapper.
    expect(markup).toContain("group/card");
    // Focus keeps them reachable from the keyboard, an open menu keeps its
    // own trigger from vanishing under the popup, and a pointer that cannot
    // hover would otherwise never reveal them at all.
    expect(wrapper).toContain("focus-within:opacity-100");
    expect(wrapper).toContain("has-[[aria-expanded=true]]:opacity-100");
    expect(wrapper).toContain("[@media(hover:none)]:opacity-100");
    // The fade is decoration; a reader who asked for less motion still gets
    // the actions, just without the transition.
    expect(wrapper).toContain("motion-reduce:transition-none");
  });

  test("puts hover actions over the pinned identity row that leads the corner", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        actionsVisibility="hover"
        stickyHeader={<span>ACME-1</span>}
      >
        <p>body</p>
      </KanbanCardShell>,
    );
    const wrapper =
      /<div[^>]*data-kanban-card-actions="hover"[^>]*>/u.exec(markup)?.[0] ??
      "";

    // Positioned in the same corner as the row, and later in the tree, so
    // only a layer of its own keeps the trigger clickable.
    expect(wrapper).toContain("absolute");
    expect(wrapper).toContain("end-1.5");
    expect(wrapper).toContain("z-10");
    expect(markup.indexOf("ACME-1")).toBeLessThan(markup.indexOf("More"));
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
