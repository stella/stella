/**
 * Pure browse logic for the public tools catalogue. Kept free of React
 * and of `@stll/catalogue` runtime imports so it stays trivially
 * testable against plain objects.
 */

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
  tags: readonly string[];
  jurisdictions: readonly string[];
};

export type ToolFilters = {
  kind: ToolsKindFilter;
  tags: ReadonlySet<string>;
  jurisdictions: ReadonlySet<string>;
};

const TOOLS_KIND_FILTER_SET: ReadonlySet<string> = new Set(TOOLS_KIND_FILTERS);

export const isToolsKindFilter = (value: string): value is ToolsKindFilter =>
  TOOLS_KIND_FILTER_SET.has(value);

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
  recommendedSlugs: ReadonlySet<string>,
): readonly T[] =>
  [...entries].sort((left, right) => {
    const leftRecommended = recommendedSlugs.has(left.slug);
    const rightRecommended = recommendedSlugs.has(right.slug);
    if (leftRecommended !== rightRecommended) {
      return leftRecommended ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  });

/**
 * Invert `recommended.json` (jurisdiction -> slugs) into slug ->
 * jurisdictions so a card can show a "Recommended in CZ, EU" badge.
 * Jurisdiction codes are returned sorted for stable rendering.
 */
export const invertRecommendedMap = (
  recommended: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<string, readonly string[]> => {
  const bySlug = new Map<string, string[]>();
  for (const [jurisdiction, slugs] of Object.entries(recommended)) {
    for (const slug of slugs) {
      const existing = bySlug.get(slug);
      if (existing) {
        existing.push(jurisdiction);
      } else {
        bySlug.set(slug, [jurisdiction]);
      }
    }
  }
  for (const jurisdictions of bySlug.values()) {
    jurisdictions.sort();
  }
  return bySlug;
};

export const collectPracticeAreas = (
  entries: readonly ToolFilterEntry[],
): readonly string[] => {
  const set = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      set.add(tag);
    }
  }
  return [...set].sort();
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
  return [...set].sort();
};

export type CatalogueStats = {
  toolCount: number;
  contributorCount: number;
};

/**
 * Social-proof counters for the catalogue header. Contributors are the
 * distinct non-blank author names across the bundle, so a malformed
 * manifest with an empty author cannot inflate the count.
 */
export const catalogueStats = (
  entries: readonly { author?: string | undefined }[],
): CatalogueStats => {
  const authors = new Set<string>();
  for (const entry of entries) {
    const author = entry.author?.trim();
    if (author) {
      authors.add(author);
    }
  }
  return { toolCount: entries.length, contributorCount: authors.size };
};

/** Present a kebab-case practice-area slug as a human label. */
export const prettifyPracticeArea = (tag: string): string =>
  tag
    .split("-")
    .map((part) =>
      part.length > 0 ? part[0]?.toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
