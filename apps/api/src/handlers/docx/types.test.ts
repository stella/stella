import { describe, expect, test } from "bun:test";

import { isTemplateDataValue } from "@/api/handlers/docx/types";

const createNestedObject = (depth: number): unknown => {
  let value: unknown = "leaf";

  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }

  return value;
};

describe("isTemplateDataValue", () => {
  test("rejects excessively deep nested values instead of recursing forever", () => {
    expect(isTemplateDataValue(createNestedObject(128))).toBe(false);
  });

  test("accepts ordinary nested values within the depth budget", () => {
    expect(
      isTemplateDataValue({
        matter: {
          client: {
            name: "Ada",
          },
        },
      }),
    ).toBe(true);
  });
});
