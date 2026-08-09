import { describe, expect, test } from "bun:test";

import { DOCX_MIME, PPTX_MIME, XLSX_MIME } from "@/lib/consts";
import {
  canOpenDesktopEdit,
  DESKTOP_EDIT_FILE_TYPES,
  getDesktopEditFileType,
} from "@/lib/desktop-edit-formats";

describe("desktop-edit format detection", () => {
  test("recognizes every supported Office MIME type", () => {
    expect(
      getDesktopEditFileType({
        fileName: "brief.docx",
        mimeType: DOCX_MIME,
      }),
    ).toBe("docx");
    expect(
      getDesktopEditFileType({
        fileName: "budget.xlsx",
        mimeType: XLSX_MIME,
      }),
    ).toBe("xlsx");
    expect(
      getDesktopEditFileType({
        fileName: "hearing.pptx",
        mimeType: PPTX_MIME,
      }),
    ).toBe("pptx");
  });

  test("accepts MIME parameters and ignores filename casing", () => {
    expect(
      getDesktopEditFileType({
        fileName: "BUDGET.XLSX",
        mimeType: `${XLSX_MIME}; charset=binary`,
      }),
    ).toBe("xlsx");
    expect(
      getDesktopEditFileType({
        fileName: "Slides.PPTX",
        mimeType: null,
      }),
    ).toBeNull();
  });

  test("does not offer desktop editing for other formats", () => {
    expect(
      getDesktopEditFileType({
        fileName: "scan.pdf",
        mimeType: "application/pdf",
      }),
    ).toBeNull();
    expect(
      getDesktopEditFileType({
        fileName: null,
        mimeType: null,
      }),
    ).toBeNull();
    expect(
      getDesktopEditFileType({
        fileName: "brief.docx",
        mimeType: "application/pdf",
      }),
    ).toBeNull();
  });

  test("keeps the supported-format registry closed and application-labelled", () => {
    expect(Object.keys(DESKTOP_EDIT_FILE_TYPES)).toEqual([
      "docx",
      "pptx",
      "xlsx",
    ]);
    expect(DESKTOP_EDIT_FILE_TYPES).toMatchObject({
      docx: { application: "Word", extension: ".docx" },
      pptx: { application: "PowerPoint", extension: ".pptx" },
      xlsx: { application: "Excel", extension: ".xlsx" },
    });
  });

  test("only exposes the action for a single supported row that is not locked by another user", () => {
    expect(
      canOpenDesktopEdit({
        context: "row",
        fileType: "xlsx",
        lockState: "unlocked",
        readOnly: false,
      }),
    ).toBe(true);
    expect(
      canOpenDesktopEdit({
        context: "row",
        fileType: "pptx",
        lockState: "locked-by-me",
        readOnly: false,
      }),
    ).toBe(true);
    expect(
      canOpenDesktopEdit({
        context: "row",
        fileType: "docx",
        lockState: "locked-by-other",
        readOnly: false,
      }),
    ).toBe(false);
    expect(
      canOpenDesktopEdit({
        context: "bulk",
        fileType: "xlsx",
        lockState: "unlocked",
        readOnly: false,
      }),
    ).toBe(false);
    expect(
      canOpenDesktopEdit({
        context: "cell",
        fileType: "docx",
        lockState: "unlocked",
        readOnly: false,
      }),
    ).toBe(false);
    expect(
      canOpenDesktopEdit({
        context: "row",
        fileType: "xlsx",
        lockState: "unlocked",
        readOnly: true,
      }),
    ).toBe(false);
  });
});
