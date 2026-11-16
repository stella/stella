import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createSavedSearchBodySchema } from "@/api/handlers/saved-searches/schema";
import { searchFacetsBodySchema } from "@/api/handlers/search/facets";
import { searchBodySchema } from "@/api/handlers/search/search";

const WORKSPACE_ID = "019857da-1f4b-7000-8000-000000000001";

// Every shared filter field set, so a field one schema stops accepting fails.
const sharedFilters = {
  query: "lease",
  workspaceIds: [WORKSPACE_ID],
  types: ["document", "matter"],
  kinds: ["document"],
  editedByUserIds: ["user_2"],
  mimeTypes: ["application/pdf"],
};

const parsers = {
  search: (filters: object) => v.safeParse(searchBodySchema, filters),
  facets: (filters: object) =>
    v.safeParse(searchFacetsBodySchema, { facet: "editor", ...filters }),
  "saved search": (filters: object) =>
    v.safeParse(createSavedSearchBodySchema, {
      name: "Leases",
      criteria: { version: 1, sort: "relevance", ...filters },
    }),
};

describe("shared search filter fields", () => {
  test.each(Object.entries(parsers))(
    "the %s body accepts the shared filters",
    (_name, parse) => {
      expect(parse(sharedFilters).issues).toBeUndefined();
    },
  );

  test.each(Object.entries(parsers))(
    "the %s body caps mimeTypes at 64",
    (_name, parse) => {
      const mimeTypes = (count: number) =>
        Array.from({ length: count }, (_, index) => `application/x-${index}`);
      expect(
        parse({ ...sharedFilters, mimeTypes: mimeTypes(64) }).success,
      ).toBe(true);
      expect(
        parse({ ...sharedFilters, mimeTypes: mimeTypes(65) }).success,
      ).toBe(false);
    },
  );
});
