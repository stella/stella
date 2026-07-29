import { describe, expect, test } from "bun:test";

import {
  canSaveSearch,
  savedSearchKeys,
  toSavedSearchCriteria,
  toSearchFilters,
} from "./saved-searches.logic";

const emptyFilters = {
  workspaceIds: [],
  types: [],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
};

describe("saved search ownership", () => {
  test("separates cache entries by organization and user", () => {
    const first = savedSearchKeys.list({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(
      savedSearchKeys.list({
        organizationId: "org-2",
        userId: "user-1",
      }),
    ).not.toEqual(first);
    expect(
      savedSearchKeys.list({
        organizationId: "org-1",
        userId: "user-2",
      }),
    ).not.toEqual(first);
  });
});

describe("saved search eligibility", () => {
  test("uses the current query value", () => {
    expect(canSaveSearch({ filters: emptyFilters, query: "agreement" })).toBe(
      true,
    );
    expect(canSaveSearch({ filters: emptyFilters, query: "   " })).toBe(false);
  });

  test("does not treat workspace scope alone as a savable filter", () => {
    expect(
      canSaveSearch({
        filters: { ...emptyFilters, workspaceIds: ["matter-1"] },
        query: "",
      }),
    ).toBe(false);
  });
});

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

  test("normalizes a legacy kind filter into the visible type state", () => {
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
      types: ["document"],
      kinds: [],
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
