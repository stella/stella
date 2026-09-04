/**
 * Read model over the bundled template-pack catalogue: the API shape of a
 * pack (no file paths, no README bodies in the list) and the ranking that
 * puts packs for the organization's jurisdictions and the caller's language
 * first. Pure over the catalogue so the list handler and its tests share it.
 */

import type { CountryCode } from "@stll/country-codes";
import {
  createBundledTemplatePackCatalogue,
  type TemplatePackCatalogue,
} from "@stll/template-packs";
import type {
  GeneratedTemplatePack,
  GeneratedTemplatePackTemplate,
} from "@stll/template-packs/schema";

import { env } from "@/api/env";
import { compareByLocale, compareCodepoint } from "@stll/collation";
import type { MemberRole } from "@/api/lib/member-roles";

let catalogue: TemplatePackCatalogue | null = null;

/**
 * The catalogue every handler reads; tests pass their own. Built on first use
 * so the content root is read after the environment is loaded: the compiled
 * image points at the directory the Dockerfile copies, a source tree falls
 * back to the submodule mount.
 */
export const getTemplatePackCatalogue = (): TemplatePackCatalogue => {
  catalogue ??= createBundledTemplatePackCatalogue(
    env.TEMPLATE_PACKS_CONTENT_DIR,
  );
  return catalogue;
};

const TEMPLATE_PACK_INSTALL_ROLES = ["admin", "owner"] as const;

/** Installing copies content into the shared library: owners and admins. */
export const canInstallTemplatePacks = (memberRole: {
  role: MemberRole;
}): boolean =>
  TEMPLATE_PACK_INSTALL_ROLES.some((role) => role === memberRole.role);

/** File paths are how the deployment finds the bytes, not part of the API. */
export type TemplatePackTemplateView = Omit<
  GeneratedTemplatePackTemplate,
  "file" | "readmeFile" | "readme"
>;

export type TemplatePackView = Omit<GeneratedTemplatePack, "templates"> & {
  templates: TemplatePackTemplateView[];
  templateCount: number;
  /** True when the pack (or one of its templates) names one of the
   *  organization's practice jurisdictions; jurisdiction-agnostic packs are
   *  neither a match nor a mismatch. */
  matchesJurisdiction: boolean;
  matchesLanguage: boolean;
};

export type TemplatePackRankingContext = {
  /** The organization's practice jurisdictions (ISO 3166-1 alpha-2). */
  countries: readonly CountryCode[];
  /** The caller's UI language as a BCP-47 tag, or null. */
  locale: string | null;
};

const toTemplateView = (
  template: GeneratedTemplatePackTemplate,
): TemplatePackTemplateView => ({
  slug: template.slug,
  title: template.title,
  jurisdictions: template.jurisdictions,
  languages: template.languages,
  legalArea: template.legalArea,
  license: template.license,
  fields: template.fields,
  sha256: template.sha256,
});

const primaryLanguage = (tag: string): string =>
  tag.split("-")[0]?.toLowerCase() ?? tag.toLowerCase();

const packCountries = (pack: GeneratedTemplatePack): Set<string> => {
  const countries = new Set(pack.jurisdictions.map((j) => j.country));
  for (const template of pack.templates) {
    for (const jurisdiction of template.jurisdictions) {
      countries.add(jurisdiction.country);
    }
  }
  return countries;
};

const packLanguages = (pack: GeneratedTemplatePack): Set<string> => {
  const languages = new Set(pack.languages.map(primaryLanguage));
  for (const template of pack.templates) {
    for (const language of template.languages) {
      languages.add(primaryLanguage(language));
    }
  }
  return languages;
};

export const toTemplatePackView = (
  pack: GeneratedTemplatePack,
  context: TemplatePackRankingContext,
): TemplatePackView => {
  const countries = packCountries(pack);
  const languages = packLanguages(pack);
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    license: pack.license,
    licenseUrl: pack.licenseUrl,
    source: pack.source,
    authors: pack.authors,
    jurisdictions: pack.jurisdictions,
    languages: pack.languages,
    legalAreas: pack.legalAreas,
    lastReviewedAt: pack.lastReviewedAt,
    disclaimer: pack.disclaimer,
    templates: pack.templates.map(toTemplateView),
    templateCount: pack.templates.length,
    matchesJurisdiction: context.countries.some((country) =>
      countries.has(country),
    ),
    matchesLanguage:
      context.locale !== null && languages.has(primaryLanguage(context.locale)),
  };
};

/** Jurisdiction matches, then agnostic packs, then the rest; language match
 *  breaks ties, then name. Stable for a given catalogue and context, so an
 *  index cursor over the result is a valid page boundary. */
const jurisdictionRank = (view: TemplatePackView): number => {
  if (view.matchesJurisdiction) {
    return 0;
  }
  const agnostic =
    view.jurisdictions.length === 0 &&
    view.templates.every((template) => template.jurisdictions.length === 0);
  return agnostic ? 1 : 2;
};

/** Names are read by the caller, so they sort in the caller's language. */
const DEFAULT_RANKING_LOCALE = "en";

export const rankTemplatePacks = (
  packs: readonly GeneratedTemplatePack[],
  context: TemplatePackRankingContext,
): TemplatePackView[] => {
  const compareNames = compareByLocale(
    context.locale ?? DEFAULT_RANKING_LOCALE,
  );
  return packs
    .map((pack) => toTemplatePackView(pack, context))
    .sort((a, b) => {
      const byJurisdiction = jurisdictionRank(a) - jurisdictionRank(b);
      if (byJurisdiction !== 0) {
        return byJurisdiction;
      }
      const byLanguage = Number(b.matchesLanguage) - Number(a.matchesLanguage);
      if (byLanguage !== 0) {
        return byLanguage;
      }
      return compareNames(a.name, b.name) || compareCodepoint(a.id, b.id);
    });
};
