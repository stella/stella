import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  canRunManualOcr,
  getDesktopEditLockState,
  getDuplicateName,
  getOcrExportFormats,
  getOcrSource,
  getOcrSources,
  hasOcrExport,
  requestDesktopEditTakeover,
} from "@/components/workspaces/row-actions.logic";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";

describe("duplicate names", () => {
  test("keeps the final extension and a recognizable source name", () => {
    expect(
      getDuplicateName({
        duplicateLabel: "Copy",
        kind: "document",
        name: "Agreement.final.docx",
      }),
    ).toBe("Agreement.final (Copy).docx");
    expect(
      getDuplicateName({
        duplicateLabel: "Copy",
        kind: "folder",
        name: "Bundle.final",
      }),
    ).toBe("Bundle.final (Copy)");
    expect(
      getDuplicateName({
        duplicateLabel: "Copy",
        kind: "document",
        name: `${"a".repeat(251)}.docx`,
      }),
    ).toHaveLength(255);
    expect(
      getDuplicateName({
        duplicateLabel: "Copy",
        kind: "document",
        name: `${"a".repeat(244)}😀.docx`,
      }),
    ).toBe(`${"a".repeat(243)} (Copy).docx`);
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

describe("desktop edit takeover", () => {
  const recordTakeover = (forceTakeover: () => Promise<void>) => {
    const events = { forced: 0, awaitedConsent: 0, reported: [] as unknown[] };
    return {
      events,
      forceTakeover: async () => {
        events.forced += 1;
        await forceTakeover();
      },
      awaitConsent: () => {
        events.awaitedConsent += 1;
      },
      reportError: (error: unknown) => {
        events.reported.push(error);
      },
    };
  };

  test("waits for the lock holder once the takeover request reaches them", async () => {
    const { events, ...handlers } = recordTakeover(async () => {});

    await requestDesktopEditTakeover({
      requestTakeover: async () => true,
      ...handlers,
    });

    expect(events).toEqual({ forced: 0, awaitedConsent: 1, reported: [] });
  });

  test("forces the takeover when the lock holder cannot be asked", async () => {
    const { events, ...handlers } = recordTakeover(async () => {});

    await requestDesktopEditTakeover({
      requestTakeover: async () => false,
      ...handlers,
    });

    expect(events).toEqual({ forced: 1, awaitedConsent: 0, reported: [] });
  });

  test("forces the takeover a single time", async () => {
    const { events, ...handlers } = recordTakeover(async () => {
      throw new Error("desktop bridge unavailable");
    });

    const outcome = await Result.tryPromise(
      async () =>
        await requestDesktopEditTakeover({
          requestTakeover: async () => false,
          ...handlers,
        }),
    );

    expect(Result.isError(outcome) ? outcome.error.cause : null).toEqual(
      new Error("desktop bridge unavailable"),
    );
    expect(events.forced).toBe(1);
  });

  test("reports a takeover request that fails, then forces the takeover", async () => {
    const { events, ...handlers } = recordTakeover(async () => {});
    const failure = new TypeError("Failed to fetch");

    await requestDesktopEditTakeover({
      requestTakeover: async () => {
        throw failure;
      },
      ...handlers,
    });

    expect(events).toEqual({
      forced: 1,
      awaitedConsent: 0,
      reported: [failure],
    });
  });
});
