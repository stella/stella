import type { TranslationKey } from "../i18n/utils";
import { pillars, type ProductSlug } from "./products/pillars";
import { productBySlug } from "./products/registry";

// Single source of truth for the Resources/Connect link groups and product nav
// entries shared by MainNav, MobileNav, and LandingFooter. Labels that are
// translated are stored as message keys (locale resolution happens at render
// time in each component); literal brand names ("Discord", "GitHub") stay
// plain strings, and the `kind` discriminator makes that distinction
// structural.

export type NavLabel =
  | { kind: "translated"; labelKey: TranslationKey }
  | { kind: "literal"; label: string };

export type NavLink = NavLabel & { href: string };

export const githubUrl = "https://github.com/stella/stella";
export const discordUrl = "https://discord.gg/8dZjmVFjTK";
export const xUrl = "https://x.com/stll_app";
export const linkedinUrl = "https://www.linkedin.com/company/stella-app";
export const statusUrl = "https://status.stll.app";
export const contactHref = "mailto:contact@stll.app";
export const selfHostingUrl = `${githubUrl}/blob/main/docs/self-hosting.md`;

export const resourceLinks = [
  { kind: "translated", labelKey: "nav.security", href: "/security" },
  { kind: "translated", labelKey: "nav.blog", href: "/blog" },
  { kind: "translated", labelKey: "nav.aiFactSheet", href: "/ai-info" },
  { kind: "translated", labelKey: "hero.selfHost", href: selfHostingUrl },
  { kind: "translated", labelKey: "footer.status", href: statusUrl },
] as const satisfies readonly NavLink[];

export const connectLinks = [
  { kind: "translated", labelKey: "footer.contact", href: contactHref },
  { kind: "literal", label: "Discord", href: discordUrl },
  { kind: "literal", label: "GitHub", href: githubUrl },
  { kind: "literal", label: "X", href: xUrl },
  { kind: "literal", label: "LinkedIn", href: linkedinUrl },
] as const satisfies readonly NavLink[];

export const isExternal = (href: string) => href.startsWith("http");

export const resolveNavLabel = (
  label: NavLabel,
  t: (key: TranslationKey) => string,
): string => (label.kind === "translated" ? t(label.labelKey) : label.label);

export const resolveNavLinks = (
  links: readonly NavLink[],
  t: (key: TranslationKey) => string,
) =>
  links.map((link) => ({ label: resolveNavLabel(link, t), href: link.href }));

// The footer names products with its own translated descriptors, keyed on the
// literal slugs, so a new pillar slug without an entry fails typecheck rather
// than silently falling back to an English label. The nav menus render
// `nav.products.<slug>.eyebrow` instead; both are catalog copy.
const productFooterLabels = {
  "public-data": { kind: "translated", labelKey: "footer.publicData" },
  anonymization: { kind: "translated", labelKey: "footer.anonymization" },
  "tabular-review": { kind: "translated", labelKey: "footer.tabularReview" },
  agent: { kind: "translated", labelKey: "footer.agent" },
  templates: { kind: "translated", labelKey: "footer.templates" },
  editor: { kind: "translated", labelKey: "footer.editor" },
  workspace: { kind: "translated", labelKey: "footer.workspace" },
  "cli-mcp": { kind: "literal", label: "CLI & MCP" },
} as const satisfies Record<ProductSlug, NavLabel>;

export type ProductNavEntry = {
  slug: ProductSlug;
  eyebrowKey: TranslationKey;
  footerLabel: NavLabel;
};

// Product pages in pillar order (the README spine), so nav surfaces and the
// footer share one ordering and cannot drift from pillars.ts. Registered
// products only: `productBySlug` guards against a pillar naming a page that
// does not exist. No `href`: every surface builds one with `productHref` from
// `data/products/links.ts`, which carries the active locale's prefix.
export const productNavEntries = pillars.flatMap((pillar) =>
  pillar.slugs.flatMap((slug) =>
    productBySlug.has(slug)
      ? [
          {
            slug,
            eyebrowKey: `nav.products.${slug}.eyebrow` as const,
            footerLabel: productFooterLabels[slug],
          },
        ]
      : [],
  ),
) satisfies readonly ProductNavEntry[];

/**
 * Every product eyebrow resolved for one locale. Astro components read
 * `nav.products.<slug>.eyebrow` straight off the translator; this exists for
 * the React islands, which have no translator of their own and take the names
 * as a prop. Written out per slug rather than derived from `productNavEntries`:
 * `Object.fromEntries` widens the keys back to `string`, and the `satisfies`
 * here makes a pillar slug without an eyebrow a typecheck error instead of an
 * undefined label at runtime.
 */
export const resolveProductEyebrows = (t: (key: TranslationKey) => string) =>
  ({
    "public-data": t("nav.products.public-data.eyebrow"),
    anonymization: t("nav.products.anonymization.eyebrow"),
    "tabular-review": t("nav.products.tabular-review.eyebrow"),
    agent: t("nav.products.agent.eyebrow"),
    templates: t("nav.products.templates.eyebrow"),
    editor: t("nav.products.editor.eyebrow"),
    workspace: t("nav.products.workspace.eyebrow"),
    "cli-mcp": t("nav.products.cli-mcp.eyebrow"),
  }) satisfies Record<ProductSlug, string>;
