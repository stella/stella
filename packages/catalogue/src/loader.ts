import { panic } from "better-result";
import * as v from "valibot";

import { GENERATED_ENTRIES, GENERATED_RECOMMENDED } from "./catalogue.gen";
import {
  catalogueEntrySchema,
  recommendedSchema,
  type CatalogueEntry,
  type CatalogueKind,
  type Recommended,
} from "./schema";

export type LoadedCatalogueEntry = CatalogueEntry & {
  icon: string | null;
};

const formatIssues = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues
    .map((issue) => `${v.getDotPath(issue) ?? "<root>"}: ${issue.message}`)
    .join("; ");

const loaded: readonly LoadedCatalogueEntry[] = GENERATED_ENTRIES.map(
  ({ manifest, icon }) => {
    const parsed = v.safeParse(catalogueEntrySchema, manifest);
    if (!parsed.success) {
      panic(`Invalid catalogue entry: ${formatIssues(parsed.issues)}`);
    }
    const output: LoadedCatalogueEntry = Object.assign(parsed.output, {
      icon,
    });
    return output;
  },
);

const parsedRecommended = (() => {
  const result = v.safeParse(recommendedSchema, GENERATED_RECOMMENDED);
  if (!result.success) {
    panic(`Invalid recommended.json: ${formatIssues(result.issues)}`);
  }
  return result.output;
})();

export const loadCatalogue = (): readonly LoadedCatalogueEntry[] => loaded;

export const loadRecommended = (): Recommended => parsedRecommended;

export type LoadedEntryByKind<K extends CatalogueKind> = Extract<
  LoadedCatalogueEntry,
  { kind: K }
>;

export const TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS = [
  "ares",
  "boe",
  "brreg",
  "infosoud",
  "prh",
  "recherche-entreprises",
  "web-search",
] as const;
export type ToggleableNativeToolBackendSlug =
  (typeof TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS)[number];

const TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUG_SET: ReadonlySet<string> = new Set(
  TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS,
);

export const isToggleableNativeToolBackendSlug = (
  slug: string,
): slug is ToggleableNativeToolBackendSlug =>
  TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUG_SET.has(slug);

export const filterCatalogueByKind = <K extends CatalogueKind>(
  kind: K,
): readonly LoadedEntryByKind<K>[] =>
  loaded.filter((entry): entry is LoadedEntryByKind<K> => entry.kind === kind);

export const findCatalogueEntry = (
  kind: CatalogueKind,
  slug: string,
): LoadedCatalogueEntry | undefined =>
  loaded.find((entry) => entry.kind === kind && entry.slug === slug);

/**
 * Always-on baseline tools. Currently only native-tools can be pinned;
 * the schema enforces that. Returned in catalogue order (which the
 * generator sorts alphabetically by slug — stable across PRs).
 */
export const pinnedCatalogueEntries = (): readonly LoadedCatalogueEntry[] =>
  loaded.filter((entry) => entry.kind === "native-tool" && entry.pinned);

/**
 * EU-27 member states. EU-tier recommendations apply when the practice
 * touches at least one of these jurisdictions — not unconditionally,
 * since GDPR/EUR-Lex/etc. aren't relevant to a JP-only practice.
 */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

const practiceTouchesEu = (
  practiceCountryCodes: ReadonlySet<string>,
): boolean => {
  for (const code of practiceCountryCodes) {
    if (EU_MEMBER_STATES.has(code.toUpperCase())) {
      return true;
    }
  }
  return false;
};

/**
 * Slugs recommended for at least one of the given jurisdictions. The
 * "EU" key in recommended.json is a wildcard tier that activates when
 * the practice touches any EU-27 member state, so GDPR-class tooling
 * surfaces for CZ/DE/FR practices but not for JP/CH/UK.
 */
export const recommendedSlugsForJurisdictions = (
  practiceCountryCodes: ReadonlySet<string>,
): ReadonlySet<string> => {
  const recommended = loadRecommended();
  const includeEu = practiceTouchesEu(practiceCountryCodes);
  const slugs = new Set<string>();
  for (const [jurisdiction, entries] of Object.entries(recommended)) {
    const isEuTier = jurisdiction.toUpperCase() === "EU";
    const match = isEuTier
      ? includeEu
      : practiceCountryCodes.has(jurisdiction.toUpperCase());
    if (match) {
      for (const slug of entries) {
        slugs.add(slug);
      }
    }
  }
  return slugs;
};
