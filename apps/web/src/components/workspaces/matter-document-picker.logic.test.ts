import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterVisibleDocuments } from "@/components/workspaces/matter-document-picker.logic";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_DOCUMENTS_MAX_COUNT = 40;
const EXPECTED_VISIBLE_DOCUMENT_LIMIT = 30;

const document = (
  entityId: string,
  name: string,
  mimeType: string = DOCX_MIME,
) => ({
  entityId,
  fileName: `${entityId}.docx`,
  mimeType,
  name,
});

const searchText = fc
  .array(
    fc.constantFrom(
      "A",
      "a",
      "Č",
      "č",
      "é",
      "e\u0301",
      "[",
      "]",
      " ",
      "\t",
      "😀",
      "\ud800",
      "\udc00",
    ),
    { maxLength: SEARCH_TEXT_MAX_CHARACTERS },
  )
  .map((characters) => characters.join(""));

/**
 * The search contract: a field matches when it contains the trimmed query once
 * both are folded for search (case, accents, ligatures, Arabic variants).
 */
const matchesFolded = (field: string | null | undefined, query: string) => {
  const needle = foldSearchMatchText(query.trim().toWellFormed());
  return (
    needle === "" ||
    (field !== null &&
      field !== undefined &&
      foldSearchMatchText(field.toWellFormed()).includes(needle))
  );
};

describe("document picker search", () => {
  it("folds accents and case while preserving source order", () => {
    const files = [
      document("first", "CAFÉ contract"),
      document("second", "cafe note", PDF_MIME),
    ];

    expect(
      filterVisibleDocuments(files, "cafe").map(({ entityId }) => entityId),
    ).toEqual(["first", "second"]);
  });

  it("keeps all supported documents for an empty query and excludes other file types", () => {
    const files = [
      document("pdf", "Brief", PDF_MIME),
      document("other", "Brief", "text/plain"),
      document("docx", "Brief"),
    ];

    expect(
      filterVisibleDocuments(files, "").map(({ entityId }) => entityId),
    ).toEqual(["pdf", "docx"]);
    expect(
      filterVisibleDocuments([document("spaced", "two  spaces")], "  "),
    ).toHaveLength(1);
  });

  it("uses the file name when the display name is absent and caps visible results", () => {
    const files = [
      {
        ...document("fallback", "ignored"),
        fileName: "café-record.docx",
        name: null,
      },
      ...Array.from({ length: EXPECTED_VISIBLE_DOCUMENT_LIMIT }, (_, index) =>
        document(`doc-${index}`, "cafe"),
      ),
    ];

    const results = filterVisibleDocuments(files, "cafe");

    expect(results).toHaveLength(EXPECTED_VISIBLE_DOCUMENT_LIMIT);
    expect(results.at(0)?.entityId).toBe("fallback");
  });

  it("matches malformed names by replacement scalar without matching emoji", () => {
    const files = [document("malformed", "\ud800"), document("emoji", "😀")];

    expect(
      filterVisibleDocuments(files, "\udc00").map(({ entityId }) => entityId),
    ).toEqual(["malformed"]);
    expect(
      filterVisibleDocuments(files, "\ufffd").map(({ entityId }) => entityId),
    ).toEqual(["malformed"]);
  });
});

it("document picker filtering keeps the supported documents whose name matches", () => {
  assertProperty(
    "document picker filtering keeps the supported documents whose name matches",
    fc.property(
      fc.array(
        fc.record({
          entityId: fc.string(),
          fileName: searchText,
          mimeType: fc.constantFrom(DOCX_MIME, PDF_MIME, "text/plain"),
          name: fc.option(searchText, { nil: null }),
        }),
        { maxLength: GENERATED_DOCUMENTS_MAX_COUNT },
      ),
      searchText,
      (files, query) => {
        const expected = files
          .filter(
            (file) =>
              (file.mimeType === DOCX_MIME || file.mimeType === PDF_MIME) &&
              matchesFolded(file.name ?? file.fileName, query),
          )
          .slice(0, EXPECTED_VISIBLE_DOCUMENT_LIMIT);

        expect(filterVisibleDocuments(files, query)).toEqual(expected);
      },
    ),
  );
});
