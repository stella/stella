import { describe, expect, test } from "bun:test";

import { toSavedSearchCriteria, toSearchFilters } from "./saved-searches.logic";

describe("saved search criteria", () => {
  test("normalizes a query and preserves a rolling time preset", () => {
    const criteria = toSavedSearchCriteria({
      query: "  recent agreements  ",
      filters: {
        workspaceIds: ["matter-1"],
        types: ["document"],
        kinds: ["document"],
        editedByUserIds: ["user-1"],
        mimeTypes: ["application/pdf"],
        time: { mode: "preset", preset: "week" },
      },
    });

    expect(criteria).toEqual({
      version: 1,
      query: "recent agreements",
      workspaceIds: ["matter-1"],
      types: ["document"],
      kinds: ["document"],
      editedByUserIds: ["user-1"],
      mimeTypes: ["application/pdf"],
      time: { type: "preset", preset: "week" },
      sort: "relevance",
    });
  });

  test("restores every filter from a filter-only saved search", () => {
    expect(
      toSearchFilters({
        version: 1,
        query: "",
        workspaceIds: ["matter-1"],
        types: [],
        kinds: ["document"],
        editedByUserIds: [],
        mimeTypes: ["application/pdf"],
        sort: "relevance",
        time: {
          type: "custom",
          updatedFrom: "2026-07-01T00:00:00.000Z",
          updatedTo: "2026-07-29T23:59:59.999Z",
        },
      }),
    ).toEqual({
      workspaceIds: ["matter-1"],
      types: [],
      kinds: ["document"],
      editedByUserIds: [],
      mimeTypes: ["application/pdf"],
      time: {
        mode: "custom",
        updatedFrom: "2026-07-01T00:00:00.000Z",
        updatedTo: "2026-07-29T23:59:59.999Z",
      },
    });
  });
});
