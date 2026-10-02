import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  AnonymizedFieldBoundaryError,
  protectValuesForAnonymization,
  RESERVED_TOKEN_PLANE,
} from "@/api/mcp/field-markers";

const firstProtectedToken = String.fromCodePoint(
  RESERVED_TOKEN_PLANE.protectedPlaceholder.start,
);

describe("values protected through anonymization", () => {
  test("hides each value from the pipeline and restores it afterwards", () => {
    const protectedInput = protectValuesForAnonymization({
      fields: ["[PERSON_1] met [PERSON_12].", "No placeholder here."],
      values: ["[PERSON_1]", "[PERSON_12]"],
    });
    if (Result.isError(protectedInput)) {
      throw protectedInput.error;
    }

    expect(protectedInput.value.fields.join("")).not.toContain("[PERSON_1");
    const restored = protectedInput.value.restore(
      protectedInput.value.fields.map((field) =>
        field.replace("No placeholder", "[PERSON_2]"),
      ),
    );
    expect(Result.isOk(restored) ? restored.value : restored.error).toEqual([
      "[PERSON_1] met [PERSON_12].",
      "[PERSON_2] here.",
    ]);
  });

  test("never uses a token the input already contains", () => {
    const protectedInput = protectValuesForAnonymization({
      fields: [`${firstProtectedToken} [PERSON_1]`],
      values: ["[PERSON_1]"],
    });
    if (Result.isError(protectedInput)) {
      throw protectedInput.error;
    }

    const restored = protectedInput.value.restore(protectedInput.value.fields);
    expect(Result.isOk(restored) ? restored.value : restored.error).toEqual([
      `${firstProtectedToken} [PERSON_1]`,
    ]);
  });

  test("refuses output in which a protected value's token was replaced", () => {
    const protectedInput = protectValuesForAnonymization({
      fields: ["[PERSON_1] signed."],
      values: ["[PERSON_1]"],
    });
    if (Result.isError(protectedInput)) {
      throw protectedInput.error;
    }
    const [field = ""] = protectedInput.value.fields;
    expect(field).toContain(firstProtectedToken);

    const restored = protectedInput.value.restore([
      field.replace(firstProtectedToken, "[ORGANIZATION_1]"),
    ]);

    expect(Result.isError(restored) ? restored.error : null).toBeInstanceOf(
      AnonymizedFieldBoundaryError,
    );
  });
});
