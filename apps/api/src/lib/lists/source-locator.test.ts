import { describe, expect, test } from "bun:test";

import { parseLegalListSourceLocator } from "./source-locator";

describe("parseLegalListSourceLocator", () => {
  test("accepts each supported immutable locator", () => {
    expect(parseLegalListSourceLocator({ type: "document" }).success).toBe(
      true,
    );
    expect(
      parseLegalListSourceLocator({ type: "docx-block", blockId: "clause-12" })
        .success,
    ).toBe(true);
    expect(
      parseLegalListSourceLocator({ type: "pdf-page", pageNumber: 4 }).success,
    ).toBe(true);
  });

  test("rejects unknown fields and invalid locations", () => {
    const locatorWithUnknownField: unknown = {
      type: "document",
      pageNumber: 1,
    };
    expect(parseLegalListSourceLocator(locatorWithUnknownField).success).toBe(
      false,
    );
    expect(
      parseLegalListSourceLocator({ type: "docx-block", blockId: " " }).success,
    ).toBe(false);
    expect(
      parseLegalListSourceLocator({ type: "pdf-page", pageNumber: 0 }).success,
    ).toBe(false);
  });
});
