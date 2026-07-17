import { describe, expect, test } from "bun:test";

import type { PublicToolBrowseEntry } from "@/routes/tools/-components/public-tools-index.logic";
import {
  filterPublicToolEntries,
  groupPublicToolEntries,
} from "@/routes/tools/-components/public-tools-index.logic";

const entry = (
  overrides: Partial<PublicToolBrowseEntry> &
    Pick<PublicToolBrowseEntry, "kind" | "slug">,
): PublicToolBrowseEntry => ({
  author: "stella",
  description: "",
  displayName: overrides.slug,
  jurisdictions: [],
  tags: [],
  ...overrides,
});

const skillEntry = entry({
  author: "Adrián Lerer",
  description: "Argentine citation analysis",
  displayName: "JurisRank",
  jurisdictions: ["AR"],
  kind: "skill",
  slug: "jurisrank-csjn-analysis",
  tags: ["litigation"],
});
const dataSourceEntry = entry({
  displayName: "Companies House",
  jurisdictions: ["GB"],
  kind: "native-tool",
  slug: "companies-house",
  tags: ["corporate"],
});
const includedEntry = entry({
  displayName: "Create DOCX",
  kind: "native-tool",
  pinned: true,
  slug: "create-docx",
});
const entries = [skillEntry, dataSourceEntry, includedEntry];

const noFilters = {
  jurisdictions: new Set<string>(),
  kind: "all" as const,
  query: "",
  tags: new Set<string>(),
  task: null,
};

describe("filterPublicToolEntries", () => {
  test("searches names, descriptions, authors, and metadata without accents", () => {
    expect(
      filterPublicToolEntries(entries, { ...noFilters, query: "adrian AR" }),
    ).toEqual([skillEntry]);
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        query: "corporate house",
      }),
    ).toEqual([dataSourceEntry]);
  });

  test("maps task-led discovery to the relevant catalogue entries", () => {
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        task: "verify-organizations",
      }),
    ).toEqual([dataSourceEntry]);
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        task: "prepare-documents",
      }),
    ).toEqual([includedEntry]);
  });
});

describe("groupPublicToolEntries", () => {
  test("keeps skills, external sources, and included capabilities distinct", () => {
    expect(groupPublicToolEntries(entries)).toEqual({
      skills: [skillEntry],
      "data-sources": [dataSourceEntry],
      included: [includedEntry],
    });
  });
});
