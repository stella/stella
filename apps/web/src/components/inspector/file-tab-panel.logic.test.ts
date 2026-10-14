import { describe, expect, test } from "bun:test";

import {
  getFileTabDisplayState,
  getFileTabNativePreviewKind,
  getMarkdownDraftSyncDecision,
  shouldRunFileAnonymizationPipeline,
  shouldSurfaceEmailResolutionAlert,
} from "./file-tab-panel.logic";

describe("file anonymization producer", () => {
  const runnable = {
    facet: "anonymization",
    isActive: true,
    isFullView: true,
    isMinimized: false,
    isMounted: true,
    isNativeDocxDisplay: false,
  } as const;

  test("starts the PDF pipeline for an active fullscreen idle facet", () => {
    expect(shouldRunFileAnonymizationPipeline(runnable)).toBe(true);
  });

  test("leaves native DOCX detection to the editor worker", () => {
    expect(
      shouldRunFileAnonymizationPipeline({
        ...runnable,
        isNativeDocxDisplay: true,
      }),
    ).toBe(false);
  });

  test("does not run for hidden, side-peek, or unmounted facets", () => {
    expect(
      (
        [
          { ...runnable, isActive: false },
          { ...runnable, isFullView: false },
          { ...runnable, isMinimized: true },
          { ...runnable, isMounted: false },
          { ...runnable, facet: "metadata" },
        ] as const
      ).every((input) => !shouldRunFileAnonymizationPipeline(input)),
    ).toBe(true);
  });
});

describe("file tab native preview kind", () => {
  test("uses the stored filename for extension-recovered previews", () => {
    expect(
      getFileTabNativePreviewKind({
        fileName: "thread.eml",
        mimeType: "application/octet-stream",
      }),
    ).toBe("email");
    expect(
      getFileTabNativePreviewKind({
        fileName: "notes.md",
        mimeType: "application/octet-stream",
      }),
    ).toBe("markdown");
  });

  test("routes XLSX and PPTX files to the native office viewer", () => {
    expect(
      getFileTabNativePreviewKind({
        fileName: "workbook.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("office");
    expect(
      getFileTabNativePreviewKind({
        fileName: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toBe("office");
  });

  test("reads a plain-text file without a PDF derivative", () => {
    expect(
      getFileTabNativePreviewKind({
        fileName: "notes.txt",
        mimeType: "text/plain",
      }),
    ).toBe("text");
    expect(
      getFileTabNativePreviewKind({
        fileName: "Notes.TXT",
        mimeType: "application/octet-stream",
      }),
    ).toBe("text");
    // Markdown sent as text/plain keeps its editor.
    expect(
      getFileTabNativePreviewKind({
        fileName: "notes.md",
        mimeType: "text/plain",
      }),
    ).toBe("markdown");
  });

  test("shows plain text without measuring a PDF page", () => {
    const state = getFileTabDisplayState({
      activeId: "field",
      minimized: false,
      scaleOffsets: new Map(),
      tab: {
        type: "pdf",
        id: "field",
        entityId: "entity",
        label: "notes",
        fileName: "notes.txt",
        mimeType: "text/plain",
        pdfFileId: null,
        workspaceId: "workspace",
      },
    });
    expect(state.isPlainTextDisplay).toBe(true);
    expect(state.requiresPdfMeasurement).toBe(false);
    expect(
      getFileTabDisplayState({
        activeId: "field",
        minimized: false,
        scaleOffsets: new Map(),
        tab: {
          type: "pdf",
          id: "field",
          entityId: "entity",
          label: "brief",
          fileName: "brief.pdf",
          mimeType: "application/pdf",
          pdfFileId: null,
          workspaceId: "workspace",
        },
      }).requiresPdfMeasurement,
    ).toBe(true);
  });

  test("keeps unsupported MIME types on the PDF fallback", () => {
    expect(
      getFileTabNativePreviewKind({
        fileName: "workbook.xlsx",
        mimeType: "application/octet-stream",
      }),
    ).toBe("pdf");
  });
});

describe("email chat resolution alert", () => {
  test("surfaces recovery outside Preview only for failed email resolution", () => {
    expect(
      shouldSurfaceEmailResolutionAlert({
        isEmailDisplay: true,
        isPreviewVisible: false,
        resolutionFailed: true,
      }),
    ).toBe(true);
    expect(
      shouldSurfaceEmailResolutionAlert({
        isEmailDisplay: true,
        isPreviewVisible: true,
        resolutionFailed: true,
      }),
    ).toBe(false);
    expect(
      shouldSurfaceEmailResolutionAlert({
        isEmailDisplay: false,
        isPreviewVisible: false,
        resolutionFailed: true,
      }),
    ).toBe(false);
  });
});

describe("markdown draft sync", () => {
  test("does not replace a dirty draft on same-field refetch", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-1",
        isDirty: true,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "server text",
      }),
    ).toEqual({ type: "skip" });
  });

  test("initializes and resets mode when the field changes", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-2",
        isDirty: true,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "new field text",
      }),
    ).toEqual({
      fieldId: "field-2",
      resetMode: true,
      text: "new field text",
      type: "sync",
    });
  });

  test("refreshes a clean same-field draft without forcing preview mode", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-1",
        isDirty: false,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "fresh server text",
      }),
    ).toEqual({
      fieldId: "field-1",
      resetMode: false,
      text: "fresh server text",
      type: "sync",
    });
  });
});
