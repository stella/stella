import { describe, expect, test } from "bun:test";

import { products } from "../data/products/registry";
import { localeCodes } from "../i18n/config";
import { catalogs } from "../i18n/utils";
import { ogCardHeadline } from "./og-card-path";
import { fitHeadline, measureText, TEXT_MAX_WIDTH } from "./og-card-text";

/**
 * The card clips nothing: a line wider than the box runs off the image, and
 * the overrun is only visible in a social preview nobody rebuilds to check.
 * So the invariant is the test, not any particular headline's line breaks.
 */
const expectInsideBox = (headline: string): void => {
  const { fontSize, lines } = fitHeadline(headline);
  const overflowing = lines.filter(
    (line) => measureText(line, fontSize) > TEXT_MAX_WIDTH,
  );
  expect({ headline, overflowing }).toEqual({ headline, overflowing: [] });
  expect(lines.length).toBeLessThanOrEqual(3);
};

describe("fitHeadline", () => {
  test("keeps every catalogue title inside the box, in every locale", () => {
    for (const locale of localeCodes) {
      const { meta, products: catalog } = catalogs[locale];
      for (const title of [
        meta.homeTitle,
        ...products.map(({ slug }) => catalog[slug].metaTitle),
      ]) {
        expectInsideBox(ogCardHeadline(title));
      }
    }
  });

  // A single word can be wider than the box at every size the fitter tries.
  // Wrapping cannot break it, so it used to be returned whole at the largest
  // size and drawn straight off the edge of the card.
  test("cuts a word too wide to wrap at any size", () => {
    const headline = "Grundstücksverkehrsgenehmigungszuständigkeitsübertragung";
    expectInsideBox(headline);
    expect(fitHeadline(headline).lines.at(0)).toEndWith("…");
  });

  test("does not treat a headline that ends in an ellipsis as truncated", () => {
    const { fontSize, lines } = fitHeadline("Coming soon…");
    expect(lines).toEqual(["Coming soon…"]);
    // Short enough to keep the largest size; the old ellipsis check shrank it.
    expect(fontSize).toBe(104);
  });

  test("marks dropped content on the last line it keeps", () => {
    const { lines } = fitHeadline(
      Array.from({ length: 40 }, () => "workspace").join(" "),
    );
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toEndWith("…");
  });
});
