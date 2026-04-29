import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { contactDataBoxSchema } from "@/api/db/schema-validators";
import {
  mergeContactMetadata,
  normalizeContactMetadata,
} from "@/api/handlers/contacts/contact-metadata";

describe("contact metadata", () => {
  test("validates Czech data box IDs as seven alphanumeric characters", () => {
    expect(
      Value.Check(contactDataBoxSchema, {
        id: "abc1234",
        isPrimary: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(contactDataBoxSchema, {
        id: "ABC1234",
        isPrimary: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(contactDataBoxSchema, {
        id: "abc123",
        isPrimary: false,
      }),
    ).toBe(false);
    expect(
      Value.Check(contactDataBoxSchema, {
        id: "abc12345",
        isPrimary: false,
      }),
    ).toBe(false);
    expect(
      Value.Check(contactDataBoxSchema, {
        id: "abc-123",
        isPrimary: false,
      }),
    ).toBe(false);
  });

  test("normalizes data box IDs before persistence", () => {
    expect(
      normalizeContactMetadata({
        customFields: [{ id: "field-1", label: "Reference", value: "A1" }],
        dataBoxes: [{ id: "ABC1234", isPrimary: true }],
      }),
    ).toEqual({
      customFields: [{ id: "field-1", label: "Reference", value: "A1" }],
      dataBoxes: [{ id: "abc1234", isPrimary: true }],
    });
  });

  test("merges partial metadata updates into existing metadata", () => {
    expect(
      mergeContactMetadata(
        {
          customFields: [{ id: "field-1", label: "Reference", value: "A1" }],
          legacyKey: true,
        },
        {
          dataBoxes: [{ id: "ABC1234", isPrimary: true }],
        },
      ),
    ).toEqual({
      customFields: [{ id: "field-1", label: "Reference", value: "A1" }],
      dataBoxes: [{ id: "abc1234", isPrimary: true }],
      legacyKey: true,
    });
  });
});
