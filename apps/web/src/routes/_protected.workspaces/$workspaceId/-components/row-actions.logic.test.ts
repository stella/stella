import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import {
  canRunManualOcr,
  getDesktopEditLockState,
  getOcrSource,
  getOcrSources,
  getPdfDownloadFileName,
} from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions.logic";

const firstPropertyId = toSafeId<"property">("property-first");
const selectedPropertyId = toSafeId<"property">("property-selected");
const firstFieldId = toSafeId<"field">("field-first");
const selectedFieldId = toSafeId<"field">("field-selected");

const ocrFields = {
  [firstPropertyId]: {
    id: firstFieldId,
    propertyId: firstPropertyId,
    entityId: toSafeId<"entity">("entity-test"),
    content: {
      type: "file" as const,
      version: 1 as const,
      id: "file-first",
      fileName: "first.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  },
  [selectedPropertyId]: {
    id: selectedFieldId,
    propertyId: selectedPropertyId,
    entityId: toSafeId<"entity">("entity-test"),
    content: {
      type: "file" as const,
      version: 1 as const,
      id: "file-selected",
      fileName: "selected.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "b".repeat(64),
      pdfFileId: null,
    },
  },
} satisfies WorkspaceEntity["fields"];

describe("save-as-PDF download filenames", () => {
  test("uses the source document base name with a PDF extension", () => {
    expect(getPdfDownloadFileName("Contract.docx")).toBe("Contract.pdf");
    expect(getPdfDownloadFileName("Contract.v2.DOCX")).toBe("Contract.v2.pdf");
  });

  test("appends the PDF extension when the source has no extension", () => {
    expect(getPdfDownloadFileName("Contract")).toBe("Contract.pdf");
  });

  test("does not treat a leading dot as a removable extension", () => {
    expect(getPdfDownloadFileName(".contract")).toBe(".contract.pdf");
  });
});

describe("desktop edit lock actions", () => {
  test("distinguishes an orphanable own session from another user's lock", () => {
    expect(getDesktopEditLockState(null)).toBe("unlocked");
    expect(getDesktopEditLockState({ isMe: true })).toBe("locked-by-me");
    expect(getDesktopEditLockState({ isMe: false })).toBe("locked-by-other");
  });
});

describe("getOcrSource", () => {
  test("uses the selected PDF field instead of another file field", () => {
    expect(
      getOcrSource({
        fields: ocrFields,
        propertyId: selectedPropertyId,
      }),
    ).toMatchObject({ fieldId: selectedFieldId, mimeType: "application/pdf" });
  });

  test("does not select an arbitrary file without a selected property", () => {
    expect(getOcrSource({ fields: ocrFields, propertyId: null })).toBeNull();
  });

  test("keeps every file field available for explicit keyboard selection", () => {
    expect(getOcrSources(ocrFields)).toEqual([
      expect.objectContaining({
        fieldId: firstFieldId,
        fileName: "first.pdf",
      }),
      expect.objectContaining({
        fieldId: selectedFieldId,
        fileName: "selected.pdf",
      }),
    ]);
  });
});

describe("manual OCR action visibility", () => {
  test("allows OCR from the selected PDF cell context", () => {
    const ocrSource = getOcrSource({
      fields: ocrFields,
      propertyId: selectedPropertyId,
    });

    expect(
      canRunManualOcr({
        context: "cell",
        entity: { kind: "document", readOnly: false },
        ocrSource: ocrSource ?? undefined,
      }),
    ).toBe(true);
  });

  test("does not offer a single-field OCR action for a bulk selection", () => {
    expect(
      canRunManualOcr({
        context: "bulk",
        entity: { kind: "document", readOnly: false },
        ocrSource: {
          encrypted: false,
          fieldId: selectedFieldId,
          fileName: "selected.pdf",
          mimeType: "application/pdf",
        },
      }),
    ).toBe(false);
  });
});
