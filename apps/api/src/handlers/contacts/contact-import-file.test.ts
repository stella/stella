import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CONTACT_IMPORT_SCHEMA_VERSION } from "@stll/api-contract";

import {
  inspectContactImportDocument,
  parseContactImportDocument,
  previewContactImport,
} from "@/api/handlers/contacts/contact-import-file";

const parseDocument = (text: string) => {
  const result = parseContactImportDocument(text);
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("contact import document", () => {
  test("parses quoted headers after a UTF-8 BOM", () => {
    const document = parseDocument(
      '\uFEFF"Name","Email"\n"Jane Doe","jane@example.com"',
    );

    expect(document.headers).toEqual(["Name", "Email"]);
    expect(document.rows).toEqual([["Jane Doe", "jane@example.com"]]);
  });

  test("detects a semicolon file and suggests each destination once", () => {
    const document = parseDocument(
      "Jméno;E-mail;E-mail\nJan Novák;jan@example.com;other@example.com",
    );

    expect(inspectContactImportDocument(document)).toMatchObject({
      delimiter: "semicolon",
      rowCount: 1,
      columns: [
        { sourceIndex: 0, targetField: "display_name" },
        { sourceIndex: 1, targetField: "primary_email" },
        { sourceIndex: 2, targetField: "ignore" },
      ],
    });
  });

  test("previews normalized contacts and reports invalid rows", () => {
    const document = parseDocument(
      "First name,Last name,Email\nJane,Doe,jane@example.com\nBroken,Email,not-an-email",
    );
    const result = previewContactImport({
      document,
      mapping: {
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        defaultType: "person",
        generateDisplayName: true,
        columns: [
          { sourceIndex: 0, targetField: "first_name" },
          { sourceIndex: 1, targetField: "last_name" },
          { sourceIndex: 2, targetField: "primary_email" },
        ],
      },
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      validCount: 1,
      errorCount: 1,
      rows: [
        {
          rowNumber: 2,
          contact: { displayName: "Jane Doe", type: "person" },
          issues: [],
        },
        {
          rowNumber: 3,
          contact: { displayName: "Broken Email", type: "person" },
          issues: [{ code: "invalid_email", field: "primary_email" }],
        },
      ],
    });
  });

  test("rejects mapping one destination more than once", () => {
    const result = previewContactImport({
      document: parseDocument("First,Second\nJane,Doe"),
      mapping: {
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        defaultType: "person",
        generateDisplayName: true,
        columns: [
          { sourceIndex: 0, targetField: "first_name" },
          { sourceIndex: 1, targetField: "first_name" },
        ],
      },
    });

    expect(Result.isError(result)).toBe(true);
  });
});
