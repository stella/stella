import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { CourtBadge } from "./court-badge";
import { LandingLayout, LandingRowIcon, LandingSection } from "./landing";

const classesOf = (markup: string, pattern: RegExp): string[] =>
  pattern.exec(markup)?.[1]?.split(" ") ?? [];

describe("landing layout in one column", () => {
  const markup = renderToStaticMarkup(
    <LandingLayout hero={<p>hero</p>}>
      <LandingSection heading="Matters">
        <p>row</p>
      </LandingSection>
    </LandingLayout>,
  );

  // A phone's fold leaves too little height to split between three
  // columns: each got a sliver shorter than one row under its scroll fade.
  test("splits the height between columns only side by side", () => {
    const grid = classesOf(markup, /<div class="(grid [^"]+)"/u);
    expect(grid).toContain("shrink-0");
    for (const bounded of ["flex-1", "auto-rows-fr"]) {
      expect(grid).not.toContain(bounded);
      expect(grid).toContain(`@2xl:${bounded}`);
    }
  });

  // A hero grown by a long paste on a short window took the whole height
  // and left each column's rows a zero-height viewport.
  test("keeps the columns a usable floor side by side", () => {
    const grid = classesOf(markup, /<div class="(grid [^"]+)"/u);
    expect(grid).toContain("@2xl:min-h-48");
    expect(grid).not.toContain("@2xl:min-h-0");
  });

  test("bounds a column's rows only side by side", () => {
    // The section's second child, after its heading, is the rows' scroll area.
    const rows = classesOf(
      markup,
      /<section[^>]*><div[^>]*>Matters<\/div><div[^>]*?\bclass="([^"]+)"/u,
    );
    expect(rows).toContain("@2xl:flex-1");
    expect(rows).not.toContain("flex-1");
  });

  test("lets the page scroll instead, and fill the viewport side by side", () => {
    // The first scroll area's content is the page itself.
    const page = classesOf(
      markup,
      /data-slot="scroll-area-viewport"[^>]*><div class="([^"]+)"/u,
    );
    expect(page).toContain("min-h-full");
    expect(page).toContain("@2xl:h-full");
    expect(page).not.toContain("h-full");
  });

  // A scroll box's minimum height is zero: a composer grown by a long paste
  // overflowed the fold and its send row was clipped under the columns.
  test("never clips the hero: it sits in the page's only scroll area", () => {
    const viewports = markup.match(/data-slot="scroll-area-viewport"/gu) ?? [];
    // The page and the one section's rows; nothing wraps the hero.
    expect(viewports).toHaveLength(2);
    const hero = classesOf(markup, /<div class="([^"]+)"><p>hero<\/p>/u);
    expect(hero).toContain("basis-[22rem]");
    expect(hero.some((name) => /^(?:@2xl:)?(?:min-)?h-/u.test(name))).toBe(
      false,
    );
  });
});

describe("landing row icon", () => {
  test.each(["NS", "KS", "ÚS"])(
    "sizes to a two-letter court chip (%s) instead of clipping it",
    (abbreviation) => {
      const markup = renderToStaticMarkup(
        <LandingRowIcon>
          <CourtBadge abbreviation={abbreviation} weight="outline" />
        </LandingRowIcon>,
      );
      const slotClasses = /^<span class="([^"]+)"/u
        .exec(markup)?.[1]
        ?.split(" ");
      expect(markup).toContain(`>${abbreviation}</span>`);
      // A fixed square (`size-4`) is narrower than the chip; the slot may
      // only set a minimum width.
      expect(slotClasses).toContain("min-w-4");
      expect(slotClasses).not.toContain("size-4");
      expect(slotClasses).not.toContain("w-4");
    },
  );
});
