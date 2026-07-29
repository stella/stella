import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  validateSavedSearchCriteria,
  validateSavedSearchWorkspaceAccess,
} from "./criteria";

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

  test("compares custom date ranges as instants", () => {
    const result = validateSavedSearchCriteria(
      criteria({
        query: "",
        time: {
          type: "custom",
          updatedFrom: "2026-07-29T10:00:00Z",
          updatedTo: "2026-07-29T10:00:00.100Z",
        },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
  });

  test("accepts RFC 3339 timestamps with numeric offsets", () => {
    const result = validateSavedSearchCriteria(
      criteria({
        query: "",
        time: {
          type: "custom",
          updatedFrom: "2026-07-29T12:00:00+02:00",
        },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
  });

  test("accepts only active workspace scopes", () => {
    const parsed = validateSavedSearchCriteria(
      criteria({ workspaceIds: [WORKSPACE_ID] }),
    );
    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      return;
    }

    const allowed = validateSavedSearchWorkspaceAccess(parsed.value, [
      toSafeId<"workspace">(WORKSPACE_ID),
    ]);
    const inaccessible = validateSavedSearchWorkspaceAccess(parsed.value, []);

    expect(Result.isOk(allowed)).toBe(true);
    expect(Result.isError(inaccessible)).toBe(true);
  });
});
