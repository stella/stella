import { describe, expect, test } from "bun:test";

import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_MAX_COLUMNS,
  CONTACT_IMPORT_SCHEMA_VERSION,
  parseContactImportMapping,
} from "./contact-import";
import type { ContactImportMapping } from "./contact-import";

const validMapping = {
  version: CONTACT_IMPORT_SCHEMA_VERSION,
  defaultType: "person",
  generateDisplayName: true,
  columns: [
    { sourceIndex: 0, targetField: "first_name" },
    { sourceIndex: 1, targetField: CONTACT_IMPORT_IGNORE_DESTINATION },
  ],
} satisfies ContactImportMapping;

describe("contact import mapping contract", () => {
  test("accepts a versioned mapping with an explicit ignored column", () => {
    const result = parseContactImportMapping(validMapping);

    expect(result).toEqual({ success: true, mapping: validMapping });
  });

  test("rejects an unknown target field", () => {
    const result = parseContactImportMapping({
      ...validMapping,
      columns: [{ sourceIndex: 0, targetField: "unknown_field" }],
    });

    expect(result.success).toBe(false);
  });

  test("rejects duplicate source column indexes", () => {
    const result = parseContactImportMapping({
      ...validMapping,
      columns: [
        { sourceIndex: 3, targetField: "first_name" },
        { sourceIndex: 3, targetField: "last_name" },
      ],
    });

    expect(result.success).toBe(false);
  });

  test.each([-1, 1.5])(
    "rejects an invalid source column index (%s)",
    (sourceIndex) => {
      const result = parseContactImportMapping({
        ...validMapping,
        columns: [{ sourceIndex, targetField: "first_name" }],
      });

      expect(result.success).toBe(false);
    },
  );

  test("roundtrips every declared import field through validation", () => {
    const result = parseContactImportMapping({
      ...validMapping,
      columns: CONTACT_IMPORT_FIELDS.map((targetField, sourceIndex) => ({
        sourceIndex,
        targetField,
      })),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(
      result.mapping.columns.map(({ targetField }) => targetField),
    ).toEqual([...CONTACT_IMPORT_FIELDS]);
  });

  test("accepts the column bound and rejects mappings above it", () => {
    const columns = Array.from(
      { length: CONTACT_IMPORT_MAX_COLUMNS },
      (_, sourceIndex) => ({
        sourceIndex,
        targetField: CONTACT_IMPORT_IGNORE_DESTINATION,
      }),
    );

    expect(
      parseContactImportMapping({ ...validMapping, columns }).success,
    ).toBe(true);
    const result = parseContactImportMapping({
      ...validMapping,
      columns: [
        ...columns,
        {
          sourceIndex: CONTACT_IMPORT_MAX_COLUMNS,
          targetField: CONTACT_IMPORT_IGNORE_DESTINATION,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
