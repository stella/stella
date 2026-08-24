import { describe, expect, test } from "bun:test";

import { commentTaggedText, unwrapCommentTranslation } from "./comment-markers";

const COMMENT = { id: 42, text: "Translate this" } as const;

describe("DOCX comment translation markers", () => {
  test("round-trips an exact comment wrapper", () => {
    expect(unwrapCommentTranslation(COMMENT, commentTaggedText(COMMENT))).toBe(
      COMMENT.text,
    );
    expect(
      unwrapCommentTranslation(
        COMMENT,
        "[[stella-translation:comment-42]][[/stella-translation:comment-42]]",
      ),
    ).toBe("");
  });

  test.each([
    "Translate this",
    "[[stella-translation:comment-41]]Translate this[[/stella-translation:comment-41]]",
    "[[stella-translation:comment-42]]Translate this",
    "Translate this[[/stella-translation:comment-42]]",
  ])("rejects a missing or mismatched outer wrapper", (translated) => {
    expect(unwrapCommentTranslation(COMMENT, translated)).toBeNull();
  });

  test.each([
    "[[stella-translation:comment-42]]before [[stella-translation:comment-7]] after[[/stella-translation:comment-42]]",
    "[[stella-translation:comment-42]]before [[/stella-translation:comment-7]] after[[/stella-translation:comment-42]]",
  ])("rejects nested translation control markers", (translated) => {
    expect(unwrapCommentTranslation(COMMENT, translated)).toBeNull();
  });
});
