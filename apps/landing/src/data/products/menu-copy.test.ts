import { expect, test } from "bun:test";

import en from "../../i18n/messages/en.json";
import { pillars } from "./pillars";
import { productBySlug } from "./registry";

// The mega-menu renders on every localized page, so its preview copy lives in
// the message catalogs; the unlocalized /product/<slug> pages keep rendering
// the registry's own `title`/`summary`. Typecheck ties the menu to a catalog
// key, not to the registry's English, so assert the two English sources agree:
// rewriting one without the other would ship two versions of the same line.
for (const slug of pillars.flatMap((pillar) => pillar.slugs)) {
  test(`${slug} menu copy matches the registry`, () => {
    const product = productBySlug.get(slug);
    if (!product) {
      throw new Error(`${slug} is listed by a pillar but not in the registry`);
    }
    expect(en.nav.products[slug].title).toBe(product.title);
    expect(en.nav.products[slug].blurb).toBe(product.summary);
  });
}

// Same contract for the pillar group labels the mega-menu renders from the
// catalog: pillars.ts stays the README spine, en.json stays the string.
for (const pillar of pillars) {
  test(`${pillar.id} pillar label matches the catalog`, () => {
    expect(en.nav.pillars[pillar.id]).toBe(pillar.label);
  });
}
