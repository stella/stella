import { describe, expect, test } from "bun:test";

import { assertAuthorizedSearchScope } from "@/api/lib/search/types";

describe("search authorization scope", () => {
  test("rejects calls without a workspace allowlist or authorized workspace", () => {
    expect(() => assertAuthorizedSearchScope({})).toThrow(
      "Search queries must include an authorized workspace scope",
    );
  });

  test("accepts an explicit empty workspace allowlist", () => {
    expect(() =>
      assertAuthorizedSearchScope({ workspaceIds: [] }),
    ).not.toThrow();
  });
});
