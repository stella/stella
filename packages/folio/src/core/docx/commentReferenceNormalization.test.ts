import { describe, expect, test } from "bun:test";

import type { Comment, DocumentBody, HeaderFooter } from "../types/document";
import { normalizeCommentReferences } from "./commentReferenceNormalization";

describe("comment reference normalization", () => {
  test("removes markers whose comments.xml entries are missing", () => {
    const documentBody: DocumentBody = {
      content: [
        {
          type: "paragraph",
          content: [
            { type: "commentRangeStart", id: 0 },
            {
              type: "run",
              content: [{ type: "text", text: "Visible" }],
            },
            { type: "commentRangeEnd", id: 0 },
            { type: "commentReference", id: 1 },
          ],
        },
      ],
    };
    const comments: Comment[] = [
      {
        id: 1,
        author: "Reviewer",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "commentReference", id: 404 },
              {
                type: "run",
                content: [{ type: "text", text: "Comment body" }],
              },
            ],
          },
        ],
      },
    ];
    const headers = new Map<string, HeaderFooter>([
      [
        "rIdHeader",
        {
          type: "header",
          hdrFtrType: "default",
          content: [
            {
              type: "paragraph",
              content: [{ type: "commentReference", id: 404 }],
            },
          ],
        },
      ],
    ]);

    const result = normalizeCommentReferences({
      documentBody,
      comments,
      headers,
    });

    expect(result).toEqual({
      removedDanglingReferences: 4,
      reanchoredUnbalancedRanges: 0,
    });
    const paragraph = documentBody.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    expect(paragraph.content.map((content) => content.type)).toEqual([
      "run",
      "commentReference",
    ]);
    expect(
      comments[0]?.content[0]?.content.map((content) => content.type),
    ).toEqual(["run"]);
    expect(
      headers
        .get("rIdHeader")
        ?.content[0]?.content.map((content) => content.type),
    ).toEqual([]);
  });

  test("re-anchors unbalanced valid ranges as point comments", () => {
    const documentBody: DocumentBody = {
      comments: [
        {
          id: 0,
          author: "Reviewer",
          content: [{ type: "paragraph", content: [] }],
        },
      ],
      content: [
        {
          type: "paragraph",
          content: [
            { type: "commentRangeStart", id: 0 },
            {
              type: "run",
              content: [{ type: "text", text: "Text" }],
            },
          ],
        },
      ],
    };

    const result = normalizeCommentReferences({
      documentBody,
      comments: documentBody.comments ?? [],
    });

    expect(result).toEqual({
      removedDanglingReferences: 0,
      reanchoredUnbalancedRanges: 1,
    });
    const paragraph = documentBody.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    expect(paragraph.content.at(0)).toEqual({
      type: "commentReference",
      id: 0,
    });
  });

  test("re-anchors out-of-order valid range markers as point comments", () => {
    const documentBody: DocumentBody = {
      comments: [
        {
          id: 0,
          author: "Reviewer",
          content: [{ type: "paragraph", content: [] }],
        },
      ],
      content: [
        {
          type: "paragraph",
          content: [
            { type: "commentRangeEnd", id: 0 },
            {
              type: "run",
              content: [{ type: "text", text: "Text" }],
            },
            { type: "commentRangeStart", id: 0 },
          ],
        },
      ],
    };

    const result = normalizeCommentReferences({
      documentBody,
      comments: documentBody.comments ?? [],
    });

    expect(result).toEqual({
      removedDanglingReferences: 0,
      reanchoredUnbalancedRanges: 2,
    });
    const paragraph = documentBody.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    expect(paragraph.content.map((content) => content.type)).toEqual([
      "commentReference",
      "run",
      "commentReference",
    ]);
  });
});
