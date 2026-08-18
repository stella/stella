import { describe, expect, test } from "bun:test";

import {
  customFieldId,
  readCandidateField,
  readCustomFields,
  toWireCandidate,
  withCustomFields,
  writeCandidateField,
} from "@/routes/_protected.contacts/-import-candidate";
import type { ImportCandidate } from "@/routes/_protected.contacts/-import-candidate";

const CANDIDATE = {
  type: "person",
  displayName: "Jane Doe",
  emails: [{ type: "work", address: "jane@example.com", isPrimary: true }],
  addresses: [
    {
      type: "office",
      line1: "Rua Um 10",
      city: "São Paulo",
      isPrimary: true,
    },
  ],
} as const satisfies ImportCandidate;

describe("import candidate fields", () => {
  test("reads a nested field through its import-contract name", () => {
    expect(readCandidateField(CANDIDATE, "primary_email")).toBe(
      "jane@example.com",
    );
    expect(readCandidateField(CANDIDATE, "address_line_1")).toBe("Rua Um 10");
    expect(readCandidateField(CANDIDATE, "notes")).toBe("");
  });

  test("clearing the e-mail drops the collection rather than emptying it", () => {
    const cleared = writeCandidateField(CANDIDATE, "primary_email", "");

    expect(cleared.emails).toBeUndefined();
  });

  test("clearing the street keeps an address that still carries a city", () => {
    const cleared = writeCandidateField(CANDIDATE, "address_line_1", "");

    // The server reports `address_line_required` for this row; dropping the
    // address here would hide the fault and lose the city the source stated.
    expect(cleared.addresses?.at(0)).toEqual({
      type: "office",
      line1: "",
      city: "São Paulo",
      isPrimary: true,
    });
  });

  test("clearing the street of a street-only address drops the address", () => {
    const streetOnly = writeCandidateField(
      { type: "person", displayName: "Jane Doe" },
      "address_line_1",
      "Rua Um 10",
    );

    expect(
      writeCandidateField(streetOnly, "address_line_1", "").addresses,
    ).toBeUndefined();
  });
});

describe("import custom fields", () => {
  test("derives a stable id from the label and slot", () => {
    expect(customFieldId("União estável", 4)).toBe("uniaoestavel-4");
    expect(customFieldId("", 0)).toBe("field-0");
    expect(customFieldId("RG", 0)).not.toBe(customFieldId("RG", 1));
  });

  test("removing the last custom field drops the metadata object", () => {
    const withField = withCustomFields(CANDIDATE, [
      { id: "rg-0", label: "RG", value: "12.345.678-9" },
    ]);

    expect(readCustomFields(withField)).toHaveLength(1);
    expect(withCustomFields(withField, []).metadata).toBeUndefined();
  });
});

describe("wire candidate", () => {
  test("omits absent fields instead of sending them as undefined", () => {
    const wire = toWireCandidate({ ...CANDIDATE, prefix: undefined });

    expect(Object.hasOwn(wire, "prefix")).toBe(false);
    expect(Object.hasOwn(wire, "notes")).toBe(false);
    expect(wire.emails).toEqual([...CANDIDATE.emails]);
  });

  test("drops a half-typed custom field the request schema would reject", () => {
    const wire = toWireCandidate(
      withCustomFields(CANDIDATE, [
        { id: "rg-0", label: "RG", value: "12.345.678-9" },
        { id: "field-1", label: "", value: "" },
      ]),
    );

    expect(wire.metadata?.customFields).toEqual([
      { id: "rg-0", label: "RG", value: "12.345.678-9" },
    ]);
  });

  test("drops metadata that holds nothing but blank custom fields", () => {
    const wire = toWireCandidate(
      withCustomFields(CANDIDATE, [{ id: "field-0", label: "", value: "x" }]),
    );

    expect(Object.hasOwn(wire, "metadata")).toBe(false);
  });
});
