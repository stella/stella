import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { chooseExtractionSource } from "@/api/lib/extraction-source-owner";

describe("extraction source ownership", () => {
  test("selects the same source for default and explicitly targeted uploads", () => {
    const fields = [
      {
        id: toSafeId<"field">("field-a"),
        propertyId: toSafeId<"property">("property-a"),
        content: { type: "file", id: "file-a" } as FieldContent,
      },
      {
        id: toSafeId<"field">("field-b"),
        propertyId: toSafeId<"property">("property-b"),
        content: { type: "file", id: "file-b" } as FieldContent,
      },
    ];

    expect(chooseExtractionSource(fields)?.id).toBe(fields[0]?.id);
    expect(chooseExtractionSource(fields, fields[1]?.propertyId)?.id).toBe(
      fields[1]?.id,
    );
  });
});
