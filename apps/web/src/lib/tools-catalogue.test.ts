import { describe, expect, test } from "bun:test";

import {
  collectJurisdictions,
  collectPracticeAreas,
  filterToolEntries,
  isToolsKindFilter,
  sortToolEntries,
  type ToolFilterEntry,
} from "@/lib/tools-catalogue";

const entry = (
  overrides: Partial<ToolFilterEntry> & Pick<ToolFilterEntry, "slug" | "kind">,
): ToolFilterEntry => ({
  displayName: overrides.slug,
  tags: [],
  jurisdictions: [],
  ...overrides,
});

const skill = entry({
  slug: "gdpr-skill",
  kind: "skill",
  tags: ["data-protection"],
  jurisdictions: ["EU"],
});
const mcp = entry({
  slug: "ares-mcp",
  kind: "mcp",
  tags: ["corporate"],
  jurisdictions: ["CZ"],
});
const universalTool = entry({
  slug: "web-search",
  kind: "native-tool",
  tags: [],
  jurisdictions: [],
});

const entries = [skill, mcp, universalTool];

const noFilters = {
  kind: "all" as const,
  tags: new Set<string>(),
  jurisdictions: new Set<string>(),
};

describe("isToolsKindFilter", () => {
  test("accepts known kinds and rejects others", () => {
    expect(isToolsKindFilter("all")).toBe(true);
    expect(isToolsKindFilter("native-tool")).toBe(true);
    expect(isToolsKindFilter("bogus")).toBe(false);
  });
});

describe("filterToolEntries", () => {
  test("returns everything with no filters", () => {
    expect(filterToolEntries(entries, noFilters)).toHaveLength(3);
  });

  test("filters by kind", () => {
    expect(filterToolEntries(entries, { ...noFilters, kind: "mcp" })).toEqual([
      mcp,
    ]);
  });

  test("filters by tag intersection", () => {
    expect(
      filterToolEntries(entries, {
        ...noFilters,
        tags: new Set(["corporate"]),
      }),
    ).toEqual([mcp]);
  });

  test("jurisdiction filter keeps universal (no-jurisdiction) entries", () => {
    const result = filterToolEntries(entries, {
      ...noFilters,
      jurisdictions: new Set(["CZ"]),
    });
    expect(result).toEqual([mcp, universalTool]);
  });
});

describe("sortToolEntries", () => {
  test("sorts entries alphabetically by name", () => {
    const sorted = sortToolEntries(entries);
    expect(sorted.map((item) => item.slug)).toEqual([
      "ares-mcp",
      "gdpr-skill",
      "web-search",
    ]);
  });
});

describe("facet collectors", () => {
  test("collect sorted unique practice areas and jurisdictions", () => {
    expect(collectPracticeAreas(entries)).toEqual([
      "corporate",
      "data-protection",
    ]);
    expect(collectJurisdictions(entries)).toEqual(["CZ", "EU"]);
  });
});
