import { describe, expect, test } from "bun:test";

import {
  DOCX_MIME,
  EML_MIME,
  MSG_MIME,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
} from "@/lib/consts";
import { FILE_OPEN_TARGET, resolveFileOpenTarget } from "@/lib/file-open.logic";

describe("resolveFileOpenTarget", () => {
  test("routes the mime-renderable formats to the document route", () => {
    for (const mimeType of [DOCX_MIME, PDF_MIME, XLSX_MIME, PPTX_MIME]) {
      expect(resolveFileOpenTarget(mimeType)).toBe(
        FILE_OPEN_TARGET.documentRoute,
      );
    }
  });

  test("routes emails to the matter inspector", () => {
    // Regression: the document route dropped emails into the PDF viewer,
    // whose display-purpose file fetch the server rejects with a 400.
    for (const mimeType of [EML_MIME, MSG_MIME]) {
      expect(resolveFileOpenTarget(mimeType)).toBe(
        FILE_OPEN_TARGET.workspaceInspector,
      );
    }
  });

  test("routes every format without a mime-only full-screen viewer to the matter inspector", () => {
    for (const mimeType of [
      null,
      "text/markdown",
      "text/plain",
      "image/png",
      "application/zip",
    ]) {
      expect(resolveFileOpenTarget(mimeType)).toBe(
        FILE_OPEN_TARGET.workspaceInspector,
      );
    }
  });
});
