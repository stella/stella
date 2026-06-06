import { describe, expect, test } from "bun:test";

import type { SectionBreakBlock } from "../core/layout-engine/types";
import type { HeaderFooterContent } from "../core/layout-painter/renderPage";
import {
  computeEffectiveHeaderFooterMargins,
  computeFirstPageHeaderFooterMarginExtender,
  computeHeaderFooterMarginExtender,
  type HeaderFooterExtenderContent,
  extendSectionBreakMargins,
} from "./headerFooterMargins";

const content = (height: number): HeaderFooterContent => ({
  blocks: [],
  measures: [],
  height,
  visualBottom: height,
});

describe("header and footer margin reservation", () => {
  test("default mode IGNORES first-page header (page 2+ margins)", () => {
    // Page 2+ of a `<w:titlePg/>` section must not inherit the
    // first-page header's reservation — only the regular header
    // counts. Otherwise body content sits artificially low on every
    // page that follows the title page.
    const margins = {
      top: 96,
      right: 72,
      bottom: 96,
      left: 72,
      header: 48,
      footer: 48,
    };

    // Regular header (20 px) fits within the 96 - 48 = 48 px slot, so
    // top stays 96. The first-page header (78 px) must NOT be considered.
    expect(
      computeEffectiveHeaderFooterMargins({
        margins,
        headerContent: content(20),
        firstPageHeaderContent: content(78),
      }).top,
    ).toBe(96);
  });

  test("first-page extender RESPECTS first-page header (page 1 margins)", () => {
    // Page 1 of a titlePg section uses the larger of regular and
    // first-page header heights — the first-page extender is applied
    // only to that page's margins.
    const margins = {
      top: 96,
      right: 72,
      bottom: 96,
      left: 72,
      header: 48,
      footer: 48,
    };

    expect(
      computeFirstPageHeaderFooterMarginExtender({
        headerContent: content(20),
        firstPageHeaderContent: content(78),
      })(margins).top,
    ).toBe(126);
  });

  test("keeps margins unchanged when header and footer fit", () => {
    const margins = {
      top: 96,
      right: 72,
      bottom: 96,
      left: 72,
      header: 48,
      footer: 48,
    };

    expect(
      computeEffectiveHeaderFooterMargins({
        margins,
        headerContent: content(40),
        footerContent: content(40),
      }),
    ).toBe(margins);
  });
});

describe("HF margin extender across multiple section margins (issue #400)", () => {
  test("returned extender extends every section's margins, not just the body", () => {
    // Pre-PR a section break with its own w:sectPr margins (40 px bottom)
    // would silently override the body's extension and the footer would
    // overlap body text on that section.
    const extend = computeHeaderFooterMarginExtender({
      footerContent: content(70),
    });

    const bodyMargins = {
      top: 60,
      right: 72,
      bottom: 60,
      left: 72,
      header: 48,
      footer: 48,
    };
    const sectionMargins = {
      top: 60,
      right: 72,
      bottom: 40,
      left: 72,
      header: 48,
      footer: 48,
    };

    const extendedBody = extend(bodyMargins);
    const extendedSection = extend(sectionMargins);

    // Footer is 70 px, footerDistance is 48, so bottom must be at least
    // 48 + 70 = 118 in BOTH margin sets.
    expect(extendedBody.bottom).toBe(118);
    expect(extendedSection.bottom).toBe(118);
  });

  test("extender returns input unchanged when neither header nor footer overflow", () => {
    const extend = computeHeaderFooterMarginExtender({
      headerContent: content(20),
      footerContent: content(20),
    });

    const margins = {
      top: 96,
      right: 72,
      bottom: 96,
      left: 72,
      header: 48,
      footer: 48,
    };

    expect(extend(margins)).toBe(margins);
  });

  test("extender uses the input margins' header/footer distances, not the body's", () => {
    // A section authored with w:header=24 has more available header space
    // than one with w:header=48 — the extender must read distances from
    // the *input* margins to honor that.
    const extend = computeHeaderFooterMarginExtender({
      headerContent: content(60),
    });

    const tightHeaderDistance = {
      top: 80,
      right: 72,
      bottom: 96,
      left: 72,
      header: 24,
      footer: 48,
    };
    const looseHeaderDistance = { ...tightHeaderDistance, header: 48 };

    // available = 80 - 24 = 56 < 60, must extend to 24 + 60 = 84.
    expect(extend(tightHeaderDistance).top).toBe(84);
    // available = 80 - 48 = 32 < 60, must extend to 48 + 60 = 108.
    expect(extend(looseHeaderDistance).top).toBe(108);
  });

  test("clamp: an absurdly tall header is clamped so margins never consume the entire page height", () => {
    const margins = {
      top: 96,
      right: 72,
      bottom: 96,
      left: 72,
      header: 48,
      footer: 48,
    };
    const pageSize = { w: 816, h: 500 };

    const extend = computeHeaderFooterMarginExtender({
      headerContent: content(1000), // Height 1000 on page height 500
      pageSize,
    });

    const extended = extend(margins);
    // Page height is 500, MIN_CONTENT_HEIGHT_PX is 24, so max margins is 476.
    expect(extended.top + extended.bottom).toBeLessThanOrEqual(476);
    expect(extended.top).toBeGreaterThanOrEqual(0);
    expect(extended.bottom).toBeGreaterThanOrEqual(0);
    // Content area is at least MIN_CONTENT_HEIGHT_PX (24)
    expect(pageSize.h - extended.top - extended.bottom).toBeGreaterThanOrEqual(
      24,
    );
  });
});

describe("extendSectionBreakMargins extends each section against its own page", () => {
  // A 600 px footer overflows the 48 px footer slot, pushing bottom to
  // 48 + 600 = 648. That fits a 1000 px page but exceeds a 500 px one's
  // content floor (500 - 24 = 476), where it is clamped to a 380 bottom.
  const tallFooter: HeaderFooterExtenderContent = {
    footerContent: content(600),
  };
  const bodyPageSize = { w: 816, h: 500 };
  const rawMargins = {
    top: 96,
    right: 72,
    bottom: 96,
    left: 72,
    header: 48,
    footer: 48,
  };
  // Body margins after the small-page clamp: the bottom shrinks to 380.
  const bodyMargins = computeHeaderFooterMarginExtender({
    ...tallFooter,
    pageSize: bodyPageSize,
  })(rawMargins);

  const run = (sectionBreaks: SectionBreakBlock[]): void =>
    extendSectionBreakMargins(sectionBreaks, {
      content: tallFooter,
      bodyPageSize,
      bodyMargins,
    });

  test("a section authoring its own taller page keeps the full footer reservation", () => {
    const tall: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "tall",
      pageSize: { w: 816, h: 1000 },
      margins: { ...rawMargins },
    };

    run([tall]);

    // 48 + 600 = 648 fits within 1000 - 24, so nothing is clamped.
    expect(tall.margins?.bottom).toBe(648);
  });

  test("a section inheriting the body page is clamped to it", () => {
    const inherit: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "inherit",
      margins: { ...rawMargins },
    };

    run([inherit]);

    // Clamped to 500 - 24 = 476 total; with top 96 the bottom shrinks to 380.
    expect(inherit.margins?.bottom).toBe(380);
  });

  test("a page-size-only section re-extends inherited margins for its own page", () => {
    // Inherits the body's clamped bottom (380) but renders on a 1000 px
    // page, so the footer reservation must grow back to 648 rather than
    // keep the small page's clamp.
    const biggerPage: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "bigger",
      pageSize: { w: 816, h: 1000 },
    };

    run([biggerPage]);

    expect(biggerPage.margins?.bottom).toBe(648);
  });

  test("a no-page-size section inherits an earlier section's page, not the body's", () => {
    // Section 1 switches to a 1000 px page; section 2 omits its page size,
    // so it inherits 1000 (not the 500 px body) and is not clamped.
    const first: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "first",
      pageSize: { w: 816, h: 1000 },
      margins: { ...rawMargins },
    };
    const second: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "second",
      margins: { ...rawMargins },
    };

    run([first, second]);

    expect(first.margins?.bottom).toBe(648);
    expect(second.margins?.bottom).toBe(648);
  });

  test("a pure continuation break (no page size or margins) is left untouched", () => {
    const cont: SectionBreakBlock = { kind: "sectionBreak", id: "cont" };

    run([cont]);

    expect(cont.margins).toBeUndefined();
  });
});
