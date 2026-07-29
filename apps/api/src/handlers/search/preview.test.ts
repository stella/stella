import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { searchPreviewBodySchema } from "@/api/handlers/search/preview";

describe("search preview request", () => {
  test("accepts filter-only searches without query text", () => {
    expect(
      Value.Check(searchPreviewBodySchema, {
        query: "",
        resultId: "00000000-0000-4000-8000-000000000001",
        type: "document",
      }),
    ).toBe(true);
  });
});
