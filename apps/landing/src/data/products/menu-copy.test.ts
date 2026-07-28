import { expect, test } from "bun:test";

import en from "../../i18n/messages/en.json";
import { pillars, type ProductSlug } from "./pillars";
import { products, productBySlug } from "./registry";
import { productCtaLabels } from "./types";

// Every product surface renders from the message catalog, English included, so
// the registry's own English is never read at render time. It stays the source
// of truth (marketing:check, the media pipeline, and the section/media pairing
// read it), which only works if the two agree: rewriting one without the other
// would ship two versions of the same line, and that is exactly how a headline
// once drifted from twelve catalogs. These tests are that guard.

// The mega-menu, the mobile menu, and the product page's own hero all render
// `nav.products.<slug>.*`.
for (const slug of pillars.flatMap((pillar) => pillar.slugs)) {
  test(`${slug} menu copy matches the registry`, () => {
    const product = productBySlug.get(slug);
    if (!product) {
      throw new Error(`${slug} is listed by a pillar but not in the registry`);
    }
    expect(en.nav.products[slug].title).toBe(product.title);
    expect(en.nav.products[slug].blurb).toBe(product.summary);
    expect(en.nav.products[slug].eyebrow).toBe(product.eyebrow);
  });
}

// Same contract for the pillar group labels the mega-menu renders from the
// catalog: pillars.ts stays the README spine, en.json stays the string.
for (const pillar of pillars) {
  test(`${pillar.id} pillar label matches the catalog`, () => {
    expect(en.nav.pillars[pillar.id]).toBe(pillar.label);
  });
}

// The rest of a product page: `products.<slug>.*`. The message format has no
// array form, so lists are numbered sibling keys; comparing whole subtrees (not
// key by key) makes a dropped bullet or an extra FAQ fail here rather than
// render as a gap, and every other locale inherits the shape from en through
// `i18n:check`.
// The JSON module's type is exact (one string literal per key), so the subtree
// is read back as a plain record: this asserts values, not literal types.
const pageCopy = (slug: ProductSlug): Record<string, unknown> =>
  en.products[slug];

const numbered = <T, R>(
  items: readonly T[],
  map: (item: T) => R,
): Record<string, R> =>
  Object.fromEntries(items.map((item, index) => [String(index), map(item)]));

for (const product of products) {
  test(`${product.slug} page copy matches the registry`, () => {
    expect(pageCopy(product.slug)).toEqual({
      adjacent: numbered(product.adjacent, (link) => ({ body: link.body })),
      capabilities: numbered(product.capabilities, (capability) => ({
        body: capability.body,
        title: capability.title,
      })),
      cta: { heading: product.cta.heading },
      faqs: numbered(product.faqs, (faq) => ({
        answer: faq.answer,
        question: faq.question,
      })),
      metaDescription: product.metaDescription,
      metaTitle: product.metaTitle,
      quickAnswer: {
        answer: product.quickAnswer.answer,
        question: product.quickAnswer.question,
      },
      sections: numbered(product.sections, (section) => ({
        bullets: numbered(section.bullets, (bullet) => bullet),
        heading: section.heading,
      })),
    });
  });
}

// CTA button labels are shared across pages, so they live under `common.*` and
// the registry references them by key; the `en` beside the key is what the data
// file reads as, and this keeps it honest.
const messageAt = (path: string): unknown => {
  let node: unknown = en;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = Reflect.get(node, part);
  }
  return node;
};

for (const [name, label] of Object.entries(productCtaLabels)) {
  test(`${name} CTA label matches the catalog`, () => {
    expect(messageAt(label.key)).toBe(label.en);
  });
}
