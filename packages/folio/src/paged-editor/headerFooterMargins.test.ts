import { describe, expect, test } from "bun:test";

import type { HeaderFooterContent } from "../core/layout-painter/renderPage";
import { computeEffectiveHeaderFooterMargins } from "./headerFooterMargins";

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
