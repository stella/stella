import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";

// Stub @/api/db to prevent drizzle(DATABASE_URL) from
// firing through transitive imports. This test only
// exercises justification parsing (pure functions).
void mock.module("@/api/db", () => ({
  db: {},
  // eslint-disable-next-line no-empty-function
  createScopedDb: () => async () => {},
}));
void mock.module("@/api/db/scoped", () => ({
  // eslint-disable-next-line no-empty-function
  createScopedDb: () => async () => {},
}));

const { parseJustificationContent } =
  await import("@/api/lib/bbox/generate-b-boxes-shared");
const { createMockJustifications } =
  await import("@/api/lib/workflow/generate-batch-mock");
const { parseJustificationXml } =
  await import("@/api/lib/workflow/parse-justifications");

const fieldId = (value: string) => toSafeId<"field">(value);

describe("justifications", () => {
  const filenames: JustificationFilenames = [
    {
      original: "filename",
      simplified: "f0",
      fileFieldId: fieldId("file-field-0"),
    },
  ];

  test("parses valid justification xml", () => {
    const xml = `<j f="f0">Some text <p-f0-0001 /> more text <p-f0-0002 /></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result).not.toBeNull();
    expect(result?.htmlContent).toBe(
      `Some text <span data-page-number="1" data-field-id="file-field-0">1</span> more text <span data-page-number="2" data-field-id="file-field-0">2</span>`,
    );
    expect(result?.fileFieldIds).toEqual([fieldId("file-field-0")]);
  });

  test("merges multiple files into single html", () => {
    const multiFilenames: JustificationFilenames = [
      { original: "file-a", simplified: "f0", fileFieldId: fieldId("field-a") },
      { original: "file-b", simplified: "f1", fileFieldId: fieldId("field-b") },
    ];
    const xml = [
      `<j f="f0">Text from file A <p-f0-0001 /></j>`,
      `<j f="f1">Text from file B <p-f1-0003 /></j>`,
    ].join("\n");

    const result = parseJustificationXml({
      filenames: multiFilenames,
      xml,
    }).unwrap();

    expect(result).not.toBeNull();
    expect(result?.htmlContent).toContain(
      `Text from file A <span data-page-number="1" data-field-id="field-a">1</span>`,
    );
    expect(result?.htmlContent).toContain(
      `Text from file B <span data-page-number="3" data-field-id="field-b">3</span>`,
    );
    expect(result?.fileFieldIds).toEqual([
      fieldId("field-a"),
      fieldId("field-b"),
    ]);
  });

  test("returns null for unknown filename", () => {
    const xml = `<j f="unknown">Some text <p-unknown-0001 /></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result).toBeNull();
  });

  test("skips justification element with no f attribute", () => {
    const xml = `<j f="f0">Valid</j><j>Missing f attribute</j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result).not.toBeNull();
    expect(result?.htmlContent).toBe("Valid");
  });

  test("strips citation elements with invalid tag format", () => {
    const xml = `<j f="f0">Text before <invalid-tag /> text after <p-f0-0001 /></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe(
      `Text before text after <span data-page-number="1" data-field-id="file-field-0">1</span>`,
    );
  });

  test("removes invalid tags without double spaces", () => {
    const xml = `<j f="f0"><invalid-tag /> <invalid-tag /> text <invalid-tag /> after</j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe(" text after");
  });

  test("returns failure for malformed xml", () => {
    const xml = `<j f="f0">unclosed tag <p-f0-0001`;

    const result = parseJustificationXml({ filenames, xml });

    expect(Result.isError(result)).toBe(true);
  });

  test("returns failure for xml with mismatched tags", () => {
    const xml = `<j f="f0">text</k>`;

    const result = parseJustificationXml({ filenames, xml });

    expect(Result.isError(result)).toBe(true);
  });

  test("handles escaped quotes in xml (real AI output)", () => {
    const xml = `<j f=\\"f0\\">Some text <p-f0-0001 /></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe(
      `Some text <span data-page-number="1" data-field-id="file-field-0">1</span>`,
    );
  });

  test("handles citation with non-numeric page id", () => {
    const xml = `<j f="f0">Text <p-f0-abc /> more text <p-f0-0001 /></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe(
      `Text more text <span data-page-number="1" data-field-id="file-field-0">1</span>`,
    );
  });

  test("handles empty justification element", () => {
    const xml = `<j f="f0"></j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe("");
  });

  test("handles citation with missing page segment", () => {
    const xml = `<j f="f0">Text <p /> more text</j>`;

    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result?.htmlContent).toBe("Text more text");
  });

  test("createMockJustifications produces correct justifications", () => {
    const xml = createMockJustifications(filenames);
    const result = parseJustificationXml({
      filenames,
      xml,
    }).unwrap();

    expect(result).not.toBeNull();

    if (!result) {
      return;
    }

    expect(result.htmlContent).toContain(
      `<span data-page-number="1" data-field-id="file-field-0"`,
    );
    expect(result.htmlContent).toContain(
      `<span data-page-number="2" data-field-id="file-field-0"`,
    );
    expect(result.fileFieldIds).toEqual([fieldId("file-field-0")]);

    const parsedContent = parseJustificationContent(
      result.htmlContent,
    ).unwrap();

    expect(parsedContent.pageNumbers).toEqual([1, 2]);
    expect(parsedContent.justificationText).not.toInclude("1");
    expect(parsedContent.justificationText).not.toInclude("2");
    expect(parsedContent.justificationText).not.toInclude("span");
  });
});
