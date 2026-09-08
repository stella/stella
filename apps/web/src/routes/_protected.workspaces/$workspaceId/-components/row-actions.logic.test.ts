import { describe, expect, test } from "bun:test";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import {
  canDownloadScrubbed,
  canRunManualOcr,
  getDesktopEditLockState,
  getOcrExportFormats,
  getOcrSource,
  getOcrSources,
  getRowDownloadMenu,
  hasOcrExport,
  getPdfDownloadFileName,
} from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions.logic";

describe("scrubbed download eligibility", () => {
  test("rejects files the server cannot scrub", () => {
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "application/pdf",
        sizeBytes: DOCUMENT_PROPERTIES_MAX_BYTES,
      }),
    ).toBe(true);
    expect(
      canDownloadScrubbed({
        encrypted: true,
        mimeType: "application/pdf",
        sizeBytes: 1,
      }),
    ).toBe(false);
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "application/pdf",
        sizeBytes: DOCUMENT_PROPERTIES_MAX_BYTES + 1,
      }),
    ).toBe(false);
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "text/plain",
        sizeBytes: 1,
      }),
    ).toBe(false);
  });
});

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

describe("OCR export formats", () => {
  test("offers the searchable PDF only once its derivative is stored", () => {
    expect(getOcrExportFormats("text-and-pdf")).toEqual([
      "searchable-pdf",
      "text",
    ]);
    expect(getOcrExportFormats("text")).toEqual(["text"]);
    expect(getOcrExportFormats("unavailable")).toEqual([]);
  });

  test("keeps a text-only source exportable", () => {
    const source = {
      encrypted: false,
      exportStatus: "text",
      fieldId: selectedFieldId,
      fileName: "selected.pdf",
      mimeType: "application/pdf",
    } as const;

    expect(hasOcrExport(source)).toBe(true);
    expect(hasOcrExport({ ...source, exportStatus: "unavailable" })).toBe(
      false,
    );
  });
});

describe("row download menu", () => {
  const docx = {
    encrypted: false,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const plainMenu = {
    canScrub: false,
    exportableOcrSourceCount: 0,
    hasPdfConversion: false,
    isBulk: false,
  };

  test("leads with the reference copy in a matter that has a reference", () => {
    expect(
      getRowDownloadMenu({
        ...plainMenu,
        file: docx,
        matter: { reference: "2026/001" },
      }),
    ).toEqual({ hasVariants: true, primaryVariant: "reference" });
  });

  test("offers no variants for a document whose matter has no reference", () => {
    expect(
      getRowDownloadMenu({
        ...plainMenu,
        file: docx,
        matter: { reference: "" },
      }),
    ).toEqual({ hasVariants: false, primaryVariant: "original" });
  });

  test("keeps a bulk selection on the originals", () => {
    expect(
      getRowDownloadMenu({
        ...plainMenu,
        file: docx,
        isBulk: true,
        matter: { reference: "2026/001" },
      }),
    ).toEqual({ hasVariants: false, primaryVariant: "original" });
  });

  test("still opens the submenu for a rendition the reference cannot ride", () => {
    expect(
      getRowDownloadMenu({
        ...plainMenu,
        file: { encrypted: false, mimeType: "image/png" },
        hasPdfConversion: true,
        matter: { reference: "2026/001" },
      }),
    ).toEqual({ hasVariants: true, primaryVariant: "original" });
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
          exportStatus: "unavailable",
          fieldId: selectedFieldId,
          fileName: "selected.pdf",
          mimeType: "application/pdf",
        },
      }),
    ).toBe(false);
  });
});
