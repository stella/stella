import type { ProductSlug } from "../data/products/pillars";
import type { Locale } from "./config";
import { catalogs } from "./utils";

// A product page's prose is keyed under `products.<slug>.*`. Lists (capabilities,
// sections, bullets, FAQs, cards) have no array form in the message format, so
// they are numbered sibling keys ("0", "1", ...); integer-like keys enumerate in
// ascending numeric order, so reading them back with Object.values restores the
// authored order. The data file stays the English source and owns everything
// that is not prose (media, evidence, hrefs); `menu-copy.test.ts` asserts the en
// catalog mirrors it key for key, so the counts here cannot drift from the
// data's, and `i18n:check` gives every other locale en's exact key set.
const listValues = <T>(record: Record<string, T>): T[] => Object.values(record);

export const getProductCopy = (locale: Locale, slug: ProductSlug) => {
  const copy = catalogs[locale].products[slug];
  return {
    adjacentBodies: listValues(copy.adjacent).map((card) => card.body),
    capabilities: listValues(copy.capabilities),
    ctaHeading: copy.cta.heading,
    faqs: listValues(copy.faqs),
    metaDescription: copy.metaDescription,
    metaTitle: copy.metaTitle,
    quickAnswer: copy.quickAnswer,
    sections: listValues(copy.sections).map((section) => ({
      bullets: listValues(section.bullets),
      heading: section.heading,
    })),
  };
};

// Setup prose exists only under the CLI & MCP page, so the generated catalog
// type carries it on that slug alone; a dedicated accessor keeps the shared
// resolver's slug-generic indexing intact.
export const getCliMcpSetupCopy = (locale: Locale) => {
  const setup = catalogs[locale].products["cli-mcp"].setup;
  return {
    clientBodies: listValues(setup.clients).map((client) => client.body),
    heading: setup.heading,
    intro: setup.intro,
    outro: setup.outro,
  };
};
