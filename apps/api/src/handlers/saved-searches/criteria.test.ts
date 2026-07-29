import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { validateSavedSearchCriteria } from "./criteria";

const WORKSPACE_ID = "019857da-1f4b-7000-8000-000000000001";

const criteria = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  query: "contract",
  workspaceIds: [],
  types: [],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
  sort: "relevance",
  ...overrides,
});

describe("saved search criteria", () => {
  test("normalizes search text while retaining a relative date preset", () => {
    const result = validateSavedSearchCriteria(
      criteria({
        query: "  termination clause  ",
        time: { type: "preset", preset: "month" },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toMatchObject({
        query: "termination clause",
        time: { type: "preset", preset: "month" },
      });
    }
  });

  test("rejects an empty query scoped only to a preloaded workspace", () => {
    const result = validateSavedSearchCriteria(
      criteria({ query: "", workspaceIds: [WORKSPACE_ID] }),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("allows a filter-only query when a selective filter is present", () => {
    const result = validateSavedSearchCriteria(
      criteria({ query: "", mimeTypes: [" application/pdf "] }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.mimeTypes).toEqual(["application/pdf"]);
    }
  });

  test("rejects an empty custom date filter as non-selective", () => {
    const result = validateSavedSearchCriteria(
      criteria({ query: "", time: { type: "custom" } }),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects inverted custom date ranges", () => {
    const result = validateSavedSearchCriteria(
      criteria({
        query: "",
        time: {
          type: "custom",
          updatedFrom: "2026-07-30T00:00:00.000Z",
          updatedTo: "2026-07-29T00:00:00.000Z",
        },
      }),
    );

    expect(Result.isError(result)).toBe(true);
  });
});
