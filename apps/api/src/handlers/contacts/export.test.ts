import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_SCHEMA_VERSION,
} from "@stll/api-contract";

import { contactToPortableImport } from "@/api/handlers/contacts/contact-import-export";
import {
  parseContactImportDocument,
  previewContactImport,
} from "@/api/handlers/contacts/contact-import-file";
import { escapeCSV } from "@/api/lib/csv";

test("the portable export field set roundtrips through import preview", () => {
  const portable = contactToPortableImport({
    type: "person",
    displayName: "Jane Doe",
    prefix: "Dr.",
    firstName: "Jane",
    middleName: null,
    lastName: "Doe",
    suffix: null,
    organizationName: null,
    emails: [{ type: "work", address: "jane@example.com", isPrimary: true }],
    phones: [{ type: "mobile", number: "+420123456789", isPrimary: true }],
    addresses: [
      {
        type: "office",
        line1: "Main 1",
        city: "Prague",
        country: "CZ",
        isPrimary: true,
      },
    ],
    notes: "Introduced by counsel",
    tags: ["client", "priority"],
    registrationNumber: null,
    taxId: null,
    dateOfBirthYear: 2000,
    dateOfBirthMonth: 2,
    dateOfBirthDay: 29,
    nationalityCodes: ["CZ", "BR"],
  });

  expect(Object.keys(portable)).toEqual([...CONTACT_IMPORT_FIELDS]);
  const document = parseContactImportDocument(
    `${CONTACT_IMPORT_FIELDS.join(",")}\n${CONTACT_IMPORT_FIELDS.map((field) => escapeCSV(portable[field])).join(",")}`,
  );
  expect(Result.isOk(document)).toBe(true);
  if (Result.isError(document)) {
    throw document.error;
  }

  const preview = previewContactImport({
    document: document.value,
    mapping: {
      version: CONTACT_IMPORT_SCHEMA_VERSION,
      defaultType: "person",
      generateDisplayName: false,
      taxIdScheme: "none",
      columns: CONTACT_IMPORT_FIELDS.map((targetField, sourceIndex) => ({
        sourceIndex,
        targetField,
      })),
    },
  });
  expect(Result.isOk(preview)).toBe(true);
  if (Result.isError(preview)) {
    throw preview.error;
  }

  expect(preview.value).toMatchObject({
    errorCount: 0,
    validCount: 1,
    rows: [
      {
        contact: {
          displayName: "Jane Doe",
          emails: [{ address: "jane@example.com" }],
          phones: [{ number: "+420123456789" }],
          tags: ["client", "priority"],
          dateOfBirth: { precision: "day", year: 2000, month: 2, day: 29 },
          nationalityCodes: ["CZ", "BR"],
        },
      },
    ],
  });
});
