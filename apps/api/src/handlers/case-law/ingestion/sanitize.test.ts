import { describe, expect, test } from "bun:test";

import { sanitizeMetadata } from "@/api/handlers/case-law/ingestion/sanitize";

describe("sanitizeMetadata", () => {
  test("sanitizes nested strings and arrays recursively", () => {
    expect(
      sanitizeMetadata({
        title: "A\u0000B",
        nested: {
          label: "C\u200BD",
          items: ["E\u00A0F", { note: "G\u0000H" }],
        },
      }),
    ).toEqual({
      title: "AB",
      nested: {
        label: "CD",
        items: ["E F", { note: "GH" }],
      },
    });
  });
});
