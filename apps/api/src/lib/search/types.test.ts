import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  assertAuthorizedSearchScope,
  findExtractionFileField,
} from "@/api/lib/search/types";

const firstPropertyId = toSafeId<"property">("property_1");
const targetPropertyId = toSafeId<"property">("property_2");

const fileContent = (id: string) =>
  ({
    type: "file",
    id,
    fileName: `${id}.docx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 1,
    encrypted: false,
    sha256Hex: "deadbeef",
    version: 1,
    pdfFileId: null,
    pdfDerivative: { status: "not-required" },
    thumbnailFileId: null,
    thumbnailDerivative: { status: "not-required" },
  }) as const;

describe("findExtractionFileField", () => {
  const fields = [
    { propertyId: firstPropertyId, content: fileContent("first") },
    { propertyId: targetPropertyId, content: fileContent("target") },
  ];

  test("uses the first file field by default", () => {
    expect(findExtractionFileField(fields)?.id).toBe("first");
  });

  test("selects an explicitly targeted file property", () => {
    expect(findExtractionFileField(fields, targetPropertyId)?.id).toBe(
      "target",
    );
  });
});

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
