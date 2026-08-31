import { describe, expect, test } from "bun:test";

import { validateDocxSuggestionOperations } from "@/api/lib/folio-operation-validation";

describe("DOCX suggestion operation validation", () => {
  test("returns folio's validated operation output, not the untrusted input object", () => {
    const inputOperation = {
      id: "suggestion-1",
      type: "replaceInBlock" as const,
      blockId: "block-1",
      find: "before",
      replace: "after",
    };
    const operations = validateDocxSuggestionOperations([inputOperation]);

    expect(operations).toEqual([inputOperation]);
    expect(operations?.at(0)).not.toBe(inputOperation);
  });

  test("rejects malformed operations before persistence", () => {
    expect(
      validateDocxSuggestionOperations([
        {
          id: "suggestion-1",
          type: "replaceInBlock",
          blockId: "block-1",
          find: null,
          replace: "after",
        },
      ]),
    ).toBeUndefined();
  });
});
