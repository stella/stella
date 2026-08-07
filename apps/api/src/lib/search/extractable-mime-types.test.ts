import { describe, expect, test } from "bun:test";

import { EMAIL_MIME_TYPES } from "@/api/lib/files/email-to-html";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import {
  canExtractMimeType,
  DIRECT_TEXT_MIME_TYPES,
  isDirectTextMimeType,
  isOfficeDocumentMimeType,
  normalizeMimeType,
  OFFICE_DOCUMENT_MIME_TYPES,
} from "./extractable-mime-types";

describe("classification", () => {
  /**
   * The worker dispatches on these predicates with an if/else chain,
   * so a MIME type in two sets would be routed by branch order rather
   * than by any deliberate decision. Disjointness is what makes the
   * dispatch order irrelevant.
   */
  test("every extractable format belongs to exactly one parser", () => {
    const sets: Record<string, Set<string>> = {
      direct: DIRECT_TEXT_MIME_TYPES,
      email: new Set(Object.keys(EMAIL_MIME_TYPES)),
      office: OFFICE_DOCUMENT_MIME_TYPES,
      singles: new Set<string>([DOCX_MIME_TYPE, PDF_MIME_TYPE]),
    };

    for (const [name, set] of Object.entries(sets)) {
      for (const [otherName, other] of Object.entries(sets)) {
        if (name === otherName) {
          continue;
        }
        const overlap = [...set].filter((mimeType) => other.has(mimeType));
        expect([name, otherName, overlap]).toEqual([name, otherName, []]);
      }
    }
  });

  test("every classified format is accepted by the extraction gate", () => {
    const classified = [
      ...DIRECT_TEXT_MIME_TYPES,
      ...OFFICE_DOCUMENT_MIME_TYPES,
      ...Object.keys(EMAIL_MIME_TYPES),
      DOCX_MIME_TYPE,
      PDF_MIME_TYPE,
    ];

    const rejected = classified.filter(
      (mimeType) => !canExtractMimeType(mimeType),
    );
    expect(rejected).toEqual([]);
  });

  /**
   * Folio also recovers comments and tracked-change notes, which a
   * plain Markdown conversion drops. Routing DOCX to the office
   * parser would lose them silently, with the document body still
   * extracting fine.
   */
  test("DOCX stays off the office parser", () => {
    expect(isOfficeDocumentMimeType(DOCX_MIME_TYPE)).toBe(false);
  });

  test("formats without a parser are rejected", () => {
    for (const mimeType of [
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "application/vnd.apple.pages",
      "application/zip",
      "image/png",
      "",
    ]) {
      expect([mimeType, canExtractMimeType(mimeType)]).toEqual([
        mimeType,
        false,
      ]);
    }
  });
});

describe("normalizeMimeType", () => {
  test("strips parameters and case before classifying", () => {
    expect(
      normalizeMimeType(`  ${XLSX_MIME_TYPE.toUpperCase()} ; foo=bar`),
    ).toBe(XLSX_MIME_TYPE);
    expect(isOfficeDocumentMimeType(`${XLSX_MIME_TYPE}; charset=binary`)).toBe(
      true,
    );
    expect(isDirectTextMimeType("TEXT/PLAIN; charset=utf-8")).toBe(true);
    expect(canExtractMimeType(` ${PDF_MIME_TYPE} `)).toBe(true);
  });
});
