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

  test("takes the layer its own card's positioned controls have to share", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        stickyHeader={<span>ACME-1</span>}
      >
        <p>body</p>
      </KanbanCardShell>,
    );

    // Being positioned only beats the card's flow content: a control
    // positioned later in the card's own body would paint over the row on
    // tree order alone. An overlay that has to stay over the row shares the
    // layer and wins on tree order, since the row renders first.
    const row =
      /<div class="(?<classes>[^"]*)" data-kanban-card-sticky-header=""/u
        .exec(markup)
        ?.groups?.["classes"]?.split(" ");

    expect(row).toEqual(expect.arrayContaining(["sticky", "z-10"]));
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

  test("reveals hover actions on hover, focus, and an open menu", () => {
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
    // Focus keeps them reachable from the keyboard, and an open menu keeps
    // its own trigger from vanishing under the popup it just opened.
    expect(wrapper).toContain("focus-within:opacity-100");
    expect(wrapper).toContain("has-[[aria-expanded=true]]:opacity-100");
    // The fade is decoration; a reader who asked for less motion still gets
    // the actions, just without the transition.
    expect(wrapper).toContain("motion-reduce:transition-none");
  });

  test("keeps hidden hover actions out of the pointer's way", () => {
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
    const classes = (/class="([^"]*)"/u.exec(wrapper)?.[1] ?? "").split(" ");

    // Invisible is not out of the way: a transparent overlay is still the
    // topmost hit, so at rest it must answer no pointer at all.
    expect(classes).toContain("pointer-events-none");
    // Every state that shows them hands them back, and nothing else does.
    expect(classes).toContain("group-hover/card:pointer-events-auto");
    expect(classes).toContain("focus-within:pointer-events-auto");
    expect(classes).toContain("has-[[aria-expanded=true]]:pointer-events-auto");
    expect(classes).toContain(
      "group-data-[active=true]/card:pointer-events-auto",
    );
    // Shown on a pointer that cannot hover, they were a dead zone in the
    // corner of every card: a long press there never reached the card, so it
    // never started the card's drag.
    expect(wrapper).not.toContain("hover:none");
  });

  test("reveals hover actions on the active card, the route a finger has", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        actionsVisibility="hover"
        active
      >
        <p>body</p>
      </KanbanCardShell>,
    );
    const wrapper =
      /<div[^>]*data-kanban-card-actions="hover"[^>]*>/u.exec(markup)?.[0] ??
      "";

    // A finger neither hovers nor tabs, so the card it opened is the one way
    // in. The state is published on the group the overlay already answers.
    expect(markup).toContain('class="group/card" data-active="true"');
    expect(wrapper).toContain("group-data-[active=true]/card:opacity-100");
    expect(wrapper).toContain(
      "group-data-[active=true]/card:pointer-events-auto",
    );
  });

  test("marks only an active card, so a resting card keeps its actions away", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardShell
        actions={<button type="button">More</button>}
        actionsVisibility="hover"
      >
        <p>body</p>
      </KanbanCardShell>,
    );

    // The flag is absent, not `data-active="false"`, so a resting card
    // matches nothing: every card on a board carries this overlay, and the
    // one the reader opened is meant to be the only one showing it.
    expect(markup).not.toContain("data-active");
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

    // Positioned in the same corner as the row, on the row's own layer, and
    // later in the tree: that is what keeps the trigger clickable.
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
