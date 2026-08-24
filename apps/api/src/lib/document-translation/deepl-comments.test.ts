import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { mapDeepLCommentTranslations } from "./deepl-comments";

const comments = [
  { id: 1, text: "First" },
  { id: 2, text: "" },
  { id: 3, text: "Third" },
];

describe("mapDeepLCommentTranslations", () => {
  test("maps an exact response while retaining empty comments", () => {
    const result = mapDeepLCommentTranslations(comments, ["Erste", "Dritte"]);

    expect(Result.isOk(result)).toBeTrue();
    if (Result.isError(result)) {
      return;
    }
    expect(result.value).toEqual(
      new Map([
        [1, "Erste"],
        [2, ""],
        [3, "Dritte"],
      ]),
    );
  });

  test.each([
    ["underflow", ["Erste"]],
    ["overflow", ["Erste", "Dritte", "Zusatz"]],
  ])("rejects response %s", (_scenario, translatedTexts) => {
    expect(mapDeepLCommentTranslations(comments, translatedTexts)).toEqual(
      Result.err("translation_failed"),
    );
  });
});
