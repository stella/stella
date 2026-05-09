import { describe, expect, test } from "bun:test";

import type { HeaderFooterContent } from "../core/layout-painter/renderPage";
import {
  computeEffectiveHeaderFooterMargins,
  computeHeaderFooterMarginExtender,
} from "./headerFooterMargins";

const content = (height: number): HeaderFooterContent => ({
  blocks: [],
  measures: [],
  height,
  visualBottom: height,
});

describe("header and footer margin reservation", () => {
  test("reserves body space for a tall first-page header", () => {
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
        headerContent: content(20),
        firstPageHeaderContent: content(78),
      }).top,
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
});
