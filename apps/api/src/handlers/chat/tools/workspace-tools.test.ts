import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { PropertyContent } from "@/api/db/schema-validators";
import { fieldContentForValue } from "@/api/handlers/chat/tools/workspace-tools";

const selectProperty: PropertyContent = {
  version: 1,
  type: "single-select",
  options: [{ color: "gray", value: "Open" }],
  fallback: null,
};

describe("fieldContentForValue", () => {
  test("builds the field content for a valid value", () => {
    const written = fieldContentForValue({
      content: selectProperty,
      value: "Open",
    });

    expect(Result.isOk(written) && written.value).toEqual({
      version: 1,
      type: "single-select",
      value: "Open",
    });
  });

  test("clears an int property without writing content", () => {
    const written = fieldContentForValue({
      content: { version: 1, type: "int" },
      value: null,
    });

    expect(Result.isOk(written) && written.value).toBeNull();
  });

  test("rejects a value the property type cannot hold as invalid input", () => {
    const rejections = [
      fieldContentForValue({ content: selectProperty, value: "Closed" }),
      fieldContentForValue({ content: { version: 1, type: "text" }, value: 3 }),
      fieldContentForValue({
        content: { version: 1, type: "date" },
        value: "not-a-date",
      }),
      fieldContentForValue({
        content: { version: 1, type: "file" },
        value: "",
      }),
    ];

    for (const rejection of rejections) {
      expect(Result.isError(rejection) && rejection.error).toMatchObject({
        kind: "invalid-input",
      });
    }
  });
});
