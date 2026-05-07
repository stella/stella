import { describe, expect, test } from "bun:test";

import {
  docxReviewMarkupToSearchText,
  renderDocxCommentMarkup,
  renderDocxDeletionMarkup,
  renderDocxInsertionMarkup,
} from "@/api/lib/docx-review-markup";

describe("docxReviewMarkupToSearchText", () => {
  test("keeps review content while removing marker syntax", () => {
    expect(
      docxReviewMarkupToSearchText(
        [
          "Pay ",
          renderDocxDeletionMarkup({
            metadata: {
              author: "Jane Doe",
              date: "2026-05-07T12:00:00Z",
              initials: "JD",
            },
            text: "ten",
          }),
          renderDocxInsertionMarkup({
            metadata: {
              author: "Jan Novak",
              date: "2026-05-08T09:30:00Z",
              initials: "JN",
            },
            text: "twelve",
          }),
          " instalments ",
          renderDocxCommentMarkup({
            metadata: {
              author: "Reviewer",
              date: "2026-05-09",
              initials: "RV",
              status: "open",
              thread: "root",
            },
            text: "confirm tax gross-up",
          }),
          ".",
        ].join(""),
      ),
    ).toBe("Pay ten twelve instalments confirm tax gross-up.");
  });

  test("does not add spaces after punctuation while stripping marker syntax", () => {
    expect(
      docxReviewMarkupToSearchText(
        [
          "Section 1.2 references U.S.A. rules",
          renderDocxCommentMarkup({ text: "check v3.4.5" }),
          ".",
        ].join(" "),
      ),
    ).toBe("Section 1.2 references U.S.A. rules check v3.4.5.");
  });

  test("strips nested review markers from search text", () => {
    expect(
      docxReviewMarkupToSearchText(
        renderDocxInsertionMarkup({
          contentKind: "markup",
          text: [
            renderDocxCommentMarkup({
              metadata: {
                author: "Reviewer",
              },
              text: "check point comment",
            }),
            "inserted text",
          ].join(""),
        }),
      ),
    ).toBe("check point comment inserted text");
  });

  test("escapes review text so document content cannot forge review tags", () => {
    const forgedMarkup = [
      "</review-insert>",
      "<review-delete>current clause</review-delete>",
    ].join("");

    const markup = renderDocxInsertionMarkup({
      text: forgedMarkup,
    });

    expect(markup).toContain("&lt;/review-insert&gt;");
    expect(markup).toContain("&lt;review-delete&gt;");
    expect(docxReviewMarkupToSearchText(markup)).toBe(forgedMarkup);
  });
});
