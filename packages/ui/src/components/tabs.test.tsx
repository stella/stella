import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";

// Overflow is a layout outcome, and static markup carries no layout: these
// tests pin the structure and the utilities that decide it, not the rendered
// geometry. What they can close is where the scroll container sits and what
// shares its coordinate space, which is what a scrolled tab strip gets wrong.

const TAB_LABELS = ["Overview", "Activity", "History", "Related"] as const;

const renderStrip = (listProps?: React.ComponentProps<typeof TabsList>) =>
  renderToStaticMarkup(
    <Tabs defaultValue={TAB_LABELS[0]}>
      <TabsList aria-label="Record views" {...listProps}>
        {TAB_LABELS.map((label) => (
          <TabsTab key={label} value={label}>
            {label}
          </TabsTab>
        ))}
      </TabsList>
      <TabsPanel value={TAB_LABELS[0]}>Panel</TabsPanel>
    </Tabs>,
  );

// The list holds only tabs and the indicator, so its close tag is the first
// `</div>` after it: the tabs render as `<button>` and the indicator as
// `<span>`.
const readTabList = (markup: string) => {
  const openTag = /<div[^>]*role="tablist"[^>]*>/u.exec(markup);

  if (!openTag) {
    throw new Error("no tablist element in the rendered markup");
  }

  const contentStart = openTag.index + openTag[0].length;

  return {
    openTag: openTag[0],
    content: markup.slice(contentStart, markup.indexOf("</div>", contentStart)),
  };
};

describe("TabsList overflow", () => {
  test("scrolls on the list itself, with the tabs and indicator inside it", () => {
    const { openTag, content } = readTabList(renderStrip());

    expect(openTag).toContain("overflow-auto");

    // The scroll container has to be this element. Base UI drives the list as
    // its composite root, so it is what scrolls the active tab into view on
    // mount and the focused one during arrow navigation; and it measures the
    // indicator's offset against this element's scroll origin. Move the
    // overflow to a wrapper and both stop working.
    for (const label of TAB_LABELS) {
      expect(content).toContain(`>${label}</button>`);
    }

    expect(content).toContain('data-slot="tab-indicator"');

    // A second scroll container between the list and its tabs would reintroduce
    // exactly that split, so the list owns the only one. Clipping without
    // scrolling (`overflow-hidden` on a tab that truncates) is not that split.
    expect(content).not.toMatch(/overflow(-[xy])?-(auto|scroll)/u);

    // Containment stays on the scrolling axis. Both axes would leave a
    // horizontal strip swallowing the wheel gestures meant for the page: it is
    // a scroll container with no vertical range, so the gesture hits a boundary
    // it cannot chain past.
    expect(openTag).toContain(
      "data-[orientation=horizontal]:overscroll-x-contain",
    );
    expect(openTag).not.toMatch(/(?:^|["\s])overscroll-contain\b/u);
  });

  test("centres safely so an overflowing strip keeps its leading tabs", () => {
    const { openTag } = readTabList(renderStrip());

    // Plain `justify-center` centres the overflow too: the leading tabs spill
    // past the scroll origin, which no scroll position can reach.
    expect(openTag).toMatch(/\bjustify-center-safe\b/u);
    expect(openTag).not.toMatch(/\bjustify-center(?![\w-])/u);
  });

  test("hugs the tabs that fit and caps the ones that do not", () => {
    const { openTag } = readTabList(renderStrip());

    // Both, and neither alone. `w-fit` keeps a short strip exactly as wide as
    // its tabs, so the scroll container has nothing to scroll. It cannot
    // produce the scroll either: the tabs are `shrink-0 whitespace-nowrap`, so
    // the list's min-content width equals its max-content width and
    // `fit-content` resolves to the tabs' full width whatever space it is
    // given. Measured in Chromium, a 349px strip in a 238px parent overflows
    // that parent unscrolled without the cap, and scrolls 111px with it.
    expect(openTag).toMatch(/\bw-fit\b/u);
    expect(openTag).toMatch(/\bmax-w-full\b/u);

    // The bar itself would not be inert: it takes block size from the strip the
    // moment it appears and paints over the indicator on the strip's edge. The
    // WebKit pseudo-element covers the Safari versions that predate
    // `scrollbar-width`, where the standard property alone leaves a bar.
    expect(openTag).toContain("scrollbar-none");
    expect(openTag).toContain("::-webkit-scrollbar]:hidden");
  });

  test("lets a consumer override the scroll container and the alignment", () => {
    // `cn` resolves these through tailwind-merge, which has to recognise both
    // utilities as the group's members to drop the primitive's. A merge that
    // stops recognising `justify-center-safe` would silently pin every list to
    // centred.
    const { openTag } = readTabList(
      renderStrip({ className: "w-full justify-start overflow-hidden" }),
    );

    expect(openTag).toMatch(/\bjustify-start\b/u);
    expect(openTag).not.toContain("justify-center-safe");
    expect(openTag).toMatch(/\boverflow-hidden\b/u);
    expect(openTag).not.toContain("overflow-auto");
  });
});

describe("TabsTab focus ring", () => {
  test("draws the ring inside the tab, where the scroll container cannot clip it", () => {
    const { content } = readTabList(renderStrip());

    // A ring painted outside the tab's box is ink overflow: a scroll container
    // clips it instead of scrolling to it, so the tabs at the strip's ends
    // would lose part of their focus indicator. Inset is the one placement that
    // survives whatever padding a consumer gives the list.
    expect(content.match(/focus-visible:ring-inset/gu)).toHaveLength(
      TAB_LABELS.length,
    );
  });
});
