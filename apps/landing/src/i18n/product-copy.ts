import type { ProductSlug } from "../data/products/pillars";
import type { Locale } from "./config";
import { catalogs } from "./utils";

// A product page's prose is keyed under `products.<slug>.*`. Lists have no array
// form in the message format, so numbered sibling keys preserve their authored
// order. Sections with visual presentations use semantic keys instead: their
// media stays attached when copy is inserted or reordered. The catalog is the
// sole prose source; product data owns media, evidence, hrefs, brand names, and
// code snippets. `i18n:check` gives every locale the English catalog's exact key
// set.
const listValues = <T>(record: Record<string, T>): T[] => Object.values(record);

export const getProductCopy = (locale: Locale, slug: ProductSlug) => {
  const copy = catalogs[locale].products[slug];
  return {
    adjacent: copy.adjacent,
    capabilities: listValues(copy.capabilities),
    ctaHeading: copy.cta.heading,
    faqs: listValues(copy.faqs),
    metaDescription: copy.metaDescription,
    metaTitle: copy.metaTitle,
    quickAnswer: copy.quickAnswer,
    sections: Object.entries(copy.sections).map(([id, section]) => ({
      bullets: listValues(section.bullets),
      heading: section.heading,
      id,
    })),
  };
};

// Setup prose exists only under the CLI & MCP page, so the generated catalog
// type carries it on that slug alone; a dedicated accessor keeps the shared
// resolver's slug-generic indexing intact.
export const getCliMcpSetupCopy = (locale: Locale) => {
  const setup = catalogs[locale].products["cli-mcp"].setup;
  return {
    clients: setup.clients,
    heading: setup.heading,
    intro: setup.intro,
    outro: setup.outro,
  };
};
