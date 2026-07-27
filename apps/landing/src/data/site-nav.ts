import type { getTranslations } from "../i18n/utils";
import { pillars } from "./products/pillars";
import { productBySlug } from "./products/registry";

// Single source of truth for the Resources/Connect link groups and product nav
// entries shared by MainNav, MobileNav, and LandingFooter. Labels that are
// translated are stored as message keys (locale resolution happens at render
// time in each component); literal brand names ("Discord", "GitHub") stay
// plain strings, and the `kind` discriminator makes that distinction
// structural.

// Dot-path key union of the message catalog, derived from the translator so a
// stale key fails typecheck (mirrors apps/web/src/i18n/types.ts).
export type TranslationKey = Parameters<ReturnType<typeof getTranslations>>[0];

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

// The footer names products with its own translated labels (nav menus use the
// product eyebrow from the registry). New products without an entry here fall
// back to their eyebrow.
const productFooterLabels: Record<string, NavLabel | undefined> = {
  "public-data": { kind: "translated", labelKey: "footer.publicData" },
  anonymization: { kind: "translated", labelKey: "footer.anonymization" },
  "tabular-review": { kind: "translated", labelKey: "footer.tabularReview" },
  agent: { kind: "translated", labelKey: "footer.agent" },
  templates: { kind: "translated", labelKey: "footer.templates" },
  editor: { kind: "translated", labelKey: "footer.editor" },
  workspace: { kind: "translated", labelKey: "footer.workspace" },
  "cli-mcp": { kind: "literal", label: "CLI & MCP" },
};

export type ProductNavEntry = {
  slug: string;
  href: string;
  eyebrow: string;
  footerLabel: NavLabel;
};

// Product pages in pillar order (the README spine), so nav surfaces and the
// footer share one ordering and cannot drift from pillars.ts.
export const productNavEntries: readonly ProductNavEntry[] = pillars.flatMap(
  (pillar) =>
    pillar.slugs.flatMap((slug) => {
      const product = productBySlug.get(slug);
      if (!product) {
        return [];
      }
      return [
        {
          slug: product.slug,
          href: `/product/${product.slug}`,
          eyebrow: product.eyebrow,
          footerLabel: productFooterLabels[slug] ?? {
            kind: "literal",
            label: product.eyebrow,
          },
        },
      ];
    }),
);
