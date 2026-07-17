/**
 * Pure browse logic for the public tools catalogue. Kept free of React
 * and of `@stll/catalogue` runtime imports so it stays trivially
 * testable against plain objects.
 */

import type { PracticeArea } from "@stll/catalogue";

import type { TranslationKey } from "@/i18n/types";
import { getCollator } from "@/lib/collation";

export const PRACTICE_AREA_LABEL_KEY = {
  "banking-finance": "publicTools.practiceAreas.bankingFinance",
  "capital-markets": "publicTools.practiceAreas.capitalMarkets",
  commercial: "publicTools.practiceAreas.commercial",
  competition: "publicTools.practiceAreas.competition",
  corporate: "publicTools.practiceAreas.corporate",
  criminal: "publicTools.practiceAreas.criminal",
  "data-protection": "publicTools.practiceAreas.dataProtection",
  "dispute-resolution": "publicTools.practiceAreas.disputeResolution",
  employment: "publicTools.practiceAreas.employment",
  energy: "publicTools.practiceAreas.energy",
  environmental: "publicTools.practiceAreas.environmental",
  family: "publicTools.practiceAreas.family",
  immigration: "publicTools.practiceAreas.immigration",
  insolvency: "publicTools.practiceAreas.insolvency",
  "intellectual-property": "publicTools.practiceAreas.intellectualProperty",
  litigation: "publicTools.practiceAreas.litigation",
  "mergers-acquisitions": "publicTools.practiceAreas.mergersAcquisitions",
  "private-client": "publicTools.practiceAreas.privateClient",
  "public-administrative": "publicTools.practiceAreas.publicAdministrative",
  "real-estate": "publicTools.practiceAreas.realEstate",
  regulatory: "publicTools.practiceAreas.regulatory",
  tax: "publicTools.practiceAreas.tax",
  technology: "publicTools.practiceAreas.technology",
  "white-collar-crime": "publicTools.practiceAreas.whiteCollarCrime",
} as const satisfies Record<PracticeArea, TranslationKey>;

export const TOOLS_KIND_FILTERS = [
  "all",
  "skill",
  "mcp",
  "native-tool",
] as const;
export type ToolsKindFilter = (typeof TOOLS_KIND_FILTERS)[number];

export type ToolFilterEntry = {
  kind: "skill" | "mcp" | "native-tool";
  slug: string;
  displayName: string;
  tags: readonly PracticeArea[];
  jurisdictions: readonly string[];
};

export type ToolFilters = {
  kind: ToolsKindFilter;
  tags: ReadonlySet<string>;
  jurisdictions: ReadonlySet<string>;
};

const SOURCE_LOCALE = "en";

export const isToolsKindFilter = (value: string): value is ToolsKindFilter => {
  switch (value) {
    case "all":
    case "mcp":
    case "native-tool":
    case "skill":
      return true;
    default:
      return false;
  }
};

const hasIntersection = (
  values: readonly string[],
  selected: ReadonlySet<string>,
): boolean => values.some((value) => selected.has(value));

/**
 * Client-side browse filter over the static bundle. Jurisdiction and
 * tag filters are additive OR within a facet: an entry matches when it
 * touches any selected jurisdiction/tag. Entries with no jurisdictions
 * are universal and always pass the jurisdiction facet.
 */
export const filterToolEntries = <T extends ToolFilterEntry>(
  entries: readonly T[],
  { kind, tags, jurisdictions }: ToolFilters,
): readonly T[] =>
  entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) {
      return false;
    }
    if (tags.size > 0 && !hasIntersection(entry.tags, tags)) {
      return false;
    }
    if (
      jurisdictions.size > 0 &&
      entry.jurisdictions.length > 0 &&
      !hasIntersection(entry.jurisdictions, jurisdictions)
    ) {
      return false;
    }
    return true;
  });

export const sortToolEntries = <T extends ToolFilterEntry>(
  entries: readonly T[],
): readonly T[] => {
  const collator = getCollator(SOURCE_LOCALE);
  return entries.toSorted((left, right) =>
    collator.compare(left.displayName, right.displayName),
  );
};

export const collectPracticeAreas = (
  entries: readonly ToolFilterEntry[],
): readonly PracticeArea[] => {
  const set = new Set<PracticeArea>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      set.add(tag);
    }
  }
  return [...set].toSorted();
};

export const collectJurisdictions = (
  entries: readonly ToolFilterEntry[],
): readonly string[] => {
  const set = new Set<string>();
  for (const entry of entries) {
    for (const code of entry.jurisdictions) {
      set.add(code);
    }
  }
  return [...set].toSorted();
};
