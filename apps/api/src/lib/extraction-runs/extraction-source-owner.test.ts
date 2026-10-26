import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { chooseExtractionSource } from "@/api/lib/extraction-runs/extraction-source-owner";

const fileContent = (id: string): FieldContent => ({
  type: "file",
  version: 1,
  id,
  fileName: `${id}.docx`,
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: `${id}-pdf`,
  pdfDerivative: { status: "ready" },
  placeholder: "data:image/png;base64,AAAA",
  thumbnailDerivative: { status: "ready" },
  thumbnailFileId: `${id}-thumbnail`,
});

describe("extraction source ownership", () => {
  test("selects the same source for default and explicitly targeted uploads", () => {
    const fields = [
      {
        id: toSafeId<"field">("field-a"),
        propertyId: toSafeId<"property">("property-a"),
        content: fileContent("file-a"),
      },
      {
        id: toSafeId<"field">("field-b"),
        propertyId: toSafeId<"property">("property-b"),
        content: fileContent("file-b"),
      },
    ];

    expect(chooseExtractionSource(fields)?.id).toBe(fields[0]?.id);
    expect(chooseExtractionSource(fields, fields[1]?.propertyId)?.id).toBe(
      fields[1]?.id,
    );
  });
});
