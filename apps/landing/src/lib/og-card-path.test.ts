import { describe, expect, test } from "bun:test";

import { products } from "../data/products/registry";
import { localeCodes, locales } from "../i18n/config";
import { catalogs } from "../i18n/utils";
import {
  isDrawableHeadline,
  isGeneratedOgCard,
  OG_CARD_FALLBACK,
  ogCardHeadline,
  ogCardPath,
  ogCardSlug,
} from "./og-card-path";

describe("ogCardSlug", () => {
  test("flattens a URL path to one filename stem", () => {
    expect(ogCardSlug("/")).toBe("index");
    expect(ogCardSlug("/security/")).toBe("security");
    expect(ogCardSlug("/pt-br/product/tabular-review/")).toBe(
      "pt-br-product-tabular-review",
    );
    expect(ogCardSlug("/blog/relicensing-to-apache-2-0/")).toBe(
      "blog-relicensing-to-apache-2-0",
    );
  });

  test("produces a filename that needs no escaping", () => {
    for (const pathname of ["/", "/a b/", "/x_%2E/", "/../etc/passwd"]) {
      expect(ogCardSlug(pathname)).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
    }
  });
});

describe("ogCardHeadline", () => {
  test("drops the brand wrapper the title carries for search results", () => {
    expect(ogCardHeadline("stella | security")).toBe("Security");
    expect(ogCardHeadline("Legal research | stella")).toBe("Legal research");
    expect(ogCardHeadline("stella | press & brand")).toBe("Press & brand");
  });

  test("keeps a title that never names the brand", () => {
    expect(ogCardHeadline("Free Online DOCX Editor: Edit .docx")).toBe(
      "Free Online DOCX Editor: Edit .docx",
    );
  });

  test("collapses the typographic spaces the face has no glyph for", () => {
    expect(ogCardHeadline("Revue tabulaire : analyse")).toBe(
      "Revue tabulaire : analyse",
    );
  });
});

describe("card face coverage", () => {
  // A card is set in exactly one face, chosen by writing direction, because
  // resvg resolves one font per text element and draws .notdef for the rest.
  // So each face must cover its own direction's titles on its own.
  test("the ltr face covers the Latin diacritics the catalogs use", () => {
    expect(
      isDrawableHeadline("ěščřžýáíé łąężźń őű ąčęėįšųū āčēģīķļņ äöõüß", "ltr"),
    ).toBe(true);
  });

  test("the rtl face covers Arabic and the Latin words mixed into it", () => {
    expect(isDrawableHeadline("تحرير مستندات Word في", "rtl")).toBe(true);
  });

  test("each face rejects the script the other one carries", () => {
    expect(isDrawableHeadline("مساحة عمل قانونية", "ltr")).toBe(false);
    expect(isDrawableHeadline("ěščřž", "rtl")).toBe(false);
  });

  test("every locale's page titles draw in that locale's own face", () => {
    const fallback = new Set<string>();
    for (const locale of localeCodes) {
      const { meta, products: catalog } = catalogs[locale];
      const titles = [
        meta.homeTitle,
        ...products.map(({ slug }) => catalog[slug].metaTitle),
      ];
      for (const title of titles) {
        const path = ogCardPath({
          direction: locales[locale].dir,
          pathname: "/",
          title,
        });
        if (path === OG_CARD_FALLBACK) {
          fallback.add(`${locale}: ${title}`);
        }
      }
    }

    // Nothing may fall back today. A locale added in a script neither face
    // covers lands here as a failure rather than as a card full of boxes.
    expect([...fallback]).toEqual([]);
  });
});

describe("ogCardPath", () => {
  test("points a drawable title at its own generated card", () => {
    const path = ogCardPath({
      direction: "ltr",
      pathname: "/security/",
      title: "stella | security",
    });
    expect(path).toBe("/images/og/security.png");
    expect(isGeneratedOgCard(path)).toBe(true);
  });

  test("points a title its face cannot draw at the static card", () => {
    const path = ogCardPath({
      direction: "ltr",
      pathname: "/ar/",
      title: "stella | مساحة عمل قانونية",
    });
    expect(path).toBe(OG_CARD_FALLBACK);
    expect(isGeneratedOgCard(path)).toBe(false);
  });
});
