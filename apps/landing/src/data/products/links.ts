import { panic } from "better-result";

import type { Locale } from "../../i18n/config";
import { localizePath, type TranslationKey } from "../../i18n/utils";
import type { ProductSlug } from "./pillars";
import type { ProductLink } from "./types";

// Every link to a product page goes through here, so a page rendered under a
// locale prefix cannot drop the reader back onto the English page.
export const productHref = (slug: ProductSlug, locale: Locale): string =>
  localizePath(`/product/${slug}`, locale);

/**
 * Every product page's URL for one locale. Astro components call
 * `productHref` directly; this exists for the React islands, which have no
 * locale of their own and take the URLs as a prop (see `resolveProductEyebrows`
 * in `data/site-nav.ts`, whose product names ride alongside).
 */
export const resolveProductHrefs = (locale: Locale) =>
  ({
    "public-data": productHref("public-data", locale),
    anonymization: productHref("anonymization", locale),
    "tabular-review": productHref("tabular-review", locale),
    agent: productHref("agent", locale),
    templates: productHref("templates", locale),
    editor: productHref("editor", locale),
    workspace: productHref("workspace", locale),
    "cli-mcp": productHref("cli-mcp", locale),
  }) satisfies Record<ProductSlug, string>;

type ResolvedProductLink = {
  href: string;
  /** The destination's own name; see `ProductLink`. */
  titleKey: TranslationKey;
  /**
   * Declares the destination's language when it differs from the page's:
   * `/ai-info` and `/docx-editor` are English-only, so a Czech page linking to
   * them says so rather than implying a Czech document.
   */
  hreflang?: "en";
};

export const resolveProductLink = (
  link: ProductLink,
  locale: Locale,
): ResolvedProductLink => {
  switch (link.to) {
    case "product":
      return {
        href: productHref(link.slug, locale),
        titleKey: `nav.products.${link.slug}.eyebrow`,
      };
    case "ai-info":
      return {
        href: "/ai-info",
        titleKey: "nav.aiFactSheet",
        hreflang: "en",
      };
    case "docx-editor":
      return {
        href: "/docx-editor",
        titleKey: "nav.docxEditor",
        hreflang: "en",
      };
    default: {
      link satisfies never;
      return panic(`Unhandled link: ${String(link)}`);
    }
  }
};
