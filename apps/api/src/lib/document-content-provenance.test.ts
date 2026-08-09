import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  resolveCurrentExtractionFileField,
  resolveCurrentFileSourceField,
  selectCurrentExtractedContent,
} from "@/api/lib/document-content-provenance";

const currentVersionId = toSafeId<"entityVersion">("version_current");
const fieldId = toSafeId<"field">("field_current");
const propertyId = toSafeId<"property">("property_current");
const file = {
  encrypted: false,
  fileName: "agreement.pdf",
  id: "file_current",
  mimeType: "application/pdf",
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 128,
  type: "file",
  version: 1,
} satisfies FieldContent;
const currentField = { content: file, id: fieldId, propertyId };
const fields = [currentField];
const currentVersionCreatedAt = new Date("2026-01-02T00:00:00.000Z");

const projection = {
  extractedAt: new Date("2026-01-03T00:00:00.000Z"),
  sourceEntityVersionId: currentVersionId,
  sourceFieldId: fieldId,
  sourceFileId: file.id,
  sourceSha256Hex: file.sha256Hex,
};

describe("selectCurrentExtractedContent", () => {
  test("accepts an exact immutable-source match", () => {
    expect(
      selectCurrentExtractedContent({
        extracted: projection,
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields,
      }),
    ).toBe(projection);
  });

  test("rejects every stale source-identity dimension", () => {
    const staleCandidates = [
      { ...projection, sourceEntityVersionId: "version_old" },
      { ...projection, sourceFieldId: "field_old" },
      { ...projection, sourceFileId: "file_old" },
      { ...projection, sourceSha256Hex: "b".repeat(64) },
    ];

    for (const extracted of staleCandidates) {
      expect(
        selectCurrentExtractedContent({
          extracted,
          allowLegacy: true,
          currentVersionCreatedAt,
          currentVersionId,
          fields,
        }),
      ).toBeNull();
    }
  });

  test("rejects a partially populated provenance row", () => {
    expect(
      selectCurrentExtractedContent({
        extracted: { ...projection, sourceSha256Hex: null },
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields,
      }),
    ).toBeNull();
  });

  test("uses the persisted non-first source field", () => {
    const sibling = {
      content: { ...file, id: "file_sibling" },
      id: toSafeId<"field">("field_sibling"),
      propertyId: toSafeId<"property">("property_sibling"),
    };
    const selected = {
      content: { ...file, id: "file_selected" },
      id: toSafeId<"field">("field_selected"),
      propertyId: toSafeId<"property">("property_selected"),
    };
    const selectedProjection = {
      ...projection,
      sourceFieldId: selected.id,
      sourceFileId: selected.content.id,
    };

    expect(
      resolveCurrentExtractionFileField({
        currentVersionId,
        extracted: selectedProjection,
        fields: [sibling, selected],
      }),
    ).toBe(selected);
    expect(
      selectCurrentExtractedContent({
        extracted: selectedProjection,
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields: [sibling, selected],
      }),
    ).toBe(selectedProjection);
  });

  test("uses one unambiguous current file while extraction still names an older version", () => {
    expect(
      resolveCurrentFileSourceField({
        currentVersionId,
        extracted: {
          ...projection,
          sourceEntityVersionId: "version_old",
          sourceFileId: "file_old",
        },
        fields,
      }),
    ).toBe(currentField);

    expect(
      resolveCurrentFileSourceField({
        currentVersionId,
        extracted: {
          ...projection,
          sourceEntityVersionId: "version_old",
          sourceFileId: "file_old",
        },
        fields: [
          ...fields,
          {
            content: { ...file, id: "file_sibling" },
            id: toSafeId<"field">("field_sibling"),
            propertyId: toSafeId<"property">("property_sibling"),
          },
        ],
      }),
    ).toBeNull();
  });

  test("does not guess after a same-version source identity mismatch", () => {
    expect(
      resolveCurrentFileSourceField({
        currentVersionId,
        extracted: { ...projection, sourceFileId: "file_wrong" },
        fields,
      }),
    ).toBeNull();
  });

  test("accepts a legacy row only when it is not older than the current version", () => {
    const legacy = {
      ...projection,
      sourceEntityVersionId: null,
      sourceFieldId: null,
      sourceFileId: null,
      sourceSha256Hex: null,
    };

    expect(
      selectCurrentExtractedContent({
        extracted: legacy,
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields,
      }),
    ).toBe(legacy);
    expect(
      selectCurrentExtractedContent({
        extracted: {
          ...legacy,
          extractedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields,
      }),
    ).toBeNull();
  });

  test("rejects ambiguous legacy extraction for a multi-file version", () => {
    const legacy = {
      ...projection,
      sourceEntityVersionId: null,
      sourceFieldId: null,
      sourceFileId: null,
      sourceSha256Hex: null,
    };

    expect(
      selectCurrentExtractedContent({
        extracted: legacy,
        allowLegacy: true,
        currentVersionCreatedAt,
        currentVersionId,
        fields: [
          ...fields,
          {
            content: { ...file, id: "file_sibling" },
            id: toSafeId<"field">("field_sibling"),
            propertyId: toSafeId<"property">("property_sibling"),
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects a legacy row when a newer version proves the current version is a rollback", () => {
    expect(
      selectCurrentExtractedContent({
        extracted: {
          ...projection,
          sourceEntityVersionId: null,
          sourceFieldId: null,
          sourceFileId: null,
          sourceSha256Hex: null,
        },
        allowLegacy: false,
        currentVersionCreatedAt,
        currentVersionId,
        fields,
      }),
    ).toBeNull();
  });
});
