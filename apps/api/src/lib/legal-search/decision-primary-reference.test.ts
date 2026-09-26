import { describe, expect, test } from "bun:test";

import {
  DECISION_IDENTIFIER_TYPES,
  DECISION_PRIMARY_REFERENCE_TYPES,
} from "@stll/legal-ast/decision-identifier";

import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import {
  parsePrimaryReferenceType,
  primaryReferenceTypeFromStored,
} from "@/api/lib/legal-search/decision-primary-reference";

const refusal = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

describe("the primary reference type", () => {
  test("reads back every type it accepts at ingestion", () => {
    for (const type of DECISION_PRIMARY_REFERENCE_TYPES) {
      expect(
        primaryReferenceTypeFromStored(parsePrimaryReferenceType(type)),
      ).toBe(type);
    }
  });

  test("takes an absent type for a docket", () => {
    expect(parsePrimaryReferenceType(undefined)).toBe(
      DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    );
  });

  test("refuses an explicit type outside the closed list at ingestion", () => {
    // An ECLI has a field of its own and is never the primary.
    const error = refusal(() =>
      parsePrimaryReferenceType(DECISION_IDENTIFIER_TYPES.ECLI),
    );
    expect(error).toBeInstanceOf(UnpersistableDecisionFieldError);
    expect(error).toMatchObject({
      field: UNPERSISTABLE_DECISION_FIELDS.PRIMARY_REFERENCE_TYPE,
    });
  });

  test("fails a stored read it cannot type instead of defaulting it", () => {
    expect(() => primaryReferenceTypeFromStored(null)).toThrow(
      "Stored decision primary reference type is invalid",
    );
    expect(() => primaryReferenceTypeFromStored("docket")).toThrow(
      "Stored decision primary reference type is invalid",
    );
  });
});
