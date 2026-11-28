import { panic } from "better-result";

import type { Locale } from "../i18n/config";
import { localizePath, type TranslationKey } from "../i18n/utils";
import { pillars, type ProductSlug } from "./products/pillars";

type NavLabelKey = Extract<
  TranslationKey,
  | "footer.anonymization"
  | "footer.agent"
  | "footer.contact"
  | "footer.documentation"
  | "footer.editor"
  | "footer.press"
  | "footer.publicData"
  | "footer.status"
  | "footer.tabularReview"
  | "footer.templates"
  | "footer.workspace"
  | "hero.selfHost"
  | "nav.aiFactSheet"
  | "nav.blog"
  | "nav.pricing"
  | "nav.security"
>;
type ProductEyebrowKey = Extract<
  TranslationKey,
  `nav.products.${ProductSlug}.eyebrow`
>;
type ProductDiscoverKey = Extract<
  TranslationKey,
  `nav.products.${ProductSlug}.discover`
>;

// Single source of truth for the Resources/Connect link groups and product nav
// entries shared by MainNav, MobileNav, and LandingFooter. Labels that are
// translated are stored as message keys (locale resolution happens at render
// time in each component); literal brand names ("Discord", "GitHub") stay
// plain strings, and the `kind` discriminator makes that distinction
// structural.

export type NavLabel =
  | { kind: "translated"; labelKey: NavLabelKey }
  | { kind: "literal"; label: string };

// A page the site renders per locale is linked in the reader's locale; any
// other target (an unlocalized page, an external site, a mailto) as written.
type NavTarget =
  { route: "localized"; path: string } | { route: "fixed"; href: string };

export type NavLink = NavLabel & NavTarget;

// The app's entry point; a new visitor signs up there and picks a plan in
// the app, so every "Start free" and plan call to action links here.
export const appUrl = "https://my.stll.app";
export const githubUrl = "https://github.com/stella/stella";
const discordUrl = "https://discord.gg/8dZjmVFjTK";
const xUrl = "https://x.com/stll_app";
const linkedinUrl = "https://www.linkedin.com/company/stella-app";
const statusUrl = "https://status.stll.app";
export const contactHref = "mailto:contact@stll.app";
export const selfHostingUrl = `${githubUrl}/blob/main/docs/self-hosting.md`;

export const resourceLinks = [
  {
    kind: "translated",
    labelKey: "nav.pricing",
    route: "localized",
    path: "/pricing/",
  },
  {
    kind: "translated",
    labelKey: "footer.documentation",
    route: "fixed",
    href: "/docs/",
  },
  {
    kind: "translated",
    labelKey: "nav.security",
    route: "fixed",
    href: "/security/",
  },
  { kind: "translated", labelKey: "nav.blog", route: "fixed", href: "/blog/" },
  {
    kind: "translated",
    labelKey: "nav.aiFactSheet",
    route: "fixed",
    href: "/ai-info/",
  },
  {
    kind: "translated",
    labelKey: "hero.selfHost",
    route: "fixed",
    href: selfHostingUrl,
  },
  {
    kind: "translated",
    labelKey: "footer.press",
    route: "fixed",
    href: "/press/",
  },
  {
    kind: "translated",
    labelKey: "footer.status",
    route: "fixed",
    href: statusUrl,
  },
] as const satisfies readonly NavLink[];

export const connectLinks = [
  {
    kind: "translated",
    labelKey: "footer.contact",
    route: "fixed",
    href: contactHref,
  },
  { kind: "literal", label: "Discord", route: "fixed", href: discordUrl },
  { kind: "literal", label: "GitHub", route: "fixed", href: githubUrl },
  { kind: "literal", label: "X", route: "fixed", href: xUrl },
  { kind: "literal", label: "LinkedIn", route: "fixed", href: linkedinUrl },
] as const satisfies readonly NavLink[];

export const isExternal = (href: string) => href.startsWith("http");

export const resolveNavLabel = (
  label: NavLabel,
  t: (key: NavLabelKey) => string,
): string => (label.kind === "translated" ? t(label.labelKey) : label.label);

const navHref = (link: NavTarget, locale: Locale): string => {
  switch (link.route) {
    case "localized":
      return localizePath(link.path, locale);
    case "fixed":
      return link.href;
    default:
      link satisfies never;
      return panic("Unhandled nav link route");
  }
};

export const resolveNavLinks = (
  links: readonly NavLink[],
  t: (key: NavLabelKey) => string,
  locale: Locale,
) =>
  links.map((link) => ({
    label: resolveNavLabel(link, t),
    href: navHref(link, locale),
  }));

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
  eyebrowKey: ProductEyebrowKey;
  footerLabel: NavLabel;
};

// Product pages in pillar order (the README spine), so nav surfaces and the
// footer share one ordering and cannot drift from pillars.ts. The product slug
// union is backed by the total registry, so a pillar cannot name an unregistered
// page. No `href`: every surface builds one with `productHref` from
// `data/products/links.ts`, which carries the active locale's prefix.
export const productNavEntries = pillars.flatMap((pillar) =>
  pillar.slugs.map((slug) => ({
    slug,
    eyebrowKey: `nav.products.${slug}.eyebrow` as const,
    footerLabel: productFooterLabels[slug],
  })),
) satisfies readonly ProductNavEntry[];

/**
 * The "discover this product" call to action, one whole phrase per product.
 * It cannot be assembled from a verb plus the product name: languages that
 * decline put the name in the accusative ("Objevte AI agenta"), and the
 * Romance languages need an article, so only the translator can write it.
 */
export const resolveProductDiscoverLabels = (
  t: (key: ProductDiscoverKey) => string,
) =>
  ({
    "public-data": t("nav.products.public-data.discover"),
    anonymization: t("nav.products.anonymization.discover"),
    "tabular-review": t("nav.products.tabular-review.discover"),
    agent: t("nav.products.agent.discover"),
    templates: t("nav.products.templates.discover"),
    editor: t("nav.products.editor.discover"),
    workspace: t("nav.products.workspace.discover"),
    "cli-mcp": t("nav.products.cli-mcp.discover"),
  }) satisfies Record<ProductSlug, string>;
