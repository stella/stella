import { describe, expect, test } from "bun:test";

import type { Comment } from "../core/types/content";
import {
  collectCommentIdsFromContent,
  pruneOrphanedComments,
} from "./commentsHelpers";

function makeComment(id: number, parentId?: number): Comment {
  return {
    id,
    author: "Tester",
    date: "2026-05-15T00:00:00Z",
    content: [
      {
        type: "paragraph",
        formatting: {},
        content: [
          {
            type: "run",
            formatting: {},
            content: [{ type: "text", text: "x" }],
          },
        ],
      },
    ],
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

describe("collectCommentIdsFromContent", () => {
  test("returns an empty set for content with no comment markers", () => {
    const content = [
      {
        type: "paragraph",
        content: [{ type: "run", content: [{ type: "text", text: "hi" }] }],
      },
    ];
    expect(collectCommentIdsFromContent(content)).toEqual(new Set());
  });

  test("collects ids from commentRangeStart, commentRangeEnd, and commentReference", () => {
    const content = [
      {
        type: "paragraph",
        content: [
          { type: "commentRangeStart", id: 1 },
          { type: "run", content: [{ type: "text", text: "x" }] },
          { type: "commentRangeEnd", id: 1 },
          { type: "commentReference", id: 1 },
          { type: "commentRangeStart", id: 2 },
          { type: "commentRangeEnd", id: 2 },
        ],
      },
    ];
    expect(collectCommentIdsFromContent(content)).toEqual(new Set([1, 2]));
  });

  test("finds comment markers nested inside table cells", () => {
    const content = [
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: "paragraph",
                    content: [{ type: "commentRangeStart", id: 42 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    expect(collectCommentIdsFromContent(content)).toEqual(new Set([42]));
  });

  test("ignores commentRange markers whose id is missing or non-numeric", () => {
    const content = [
      {
        type: "paragraph",
        content: [
          { type: "commentRangeStart" }, // no id
          { type: "commentRangeEnd", id: "5" }, // string id
        ],
      },
    ];
    expect(collectCommentIdsFromContent(content)).toEqual(new Set());
  });
});

describe("pruneOrphanedComments", () => {
  test("keeps top-level comments that are still anchored", () => {
    const comments = [makeComment(1), makeComment(2)];
    expect(pruneOrphanedComments(comments, new Set([1, 2]))).toEqual(comments);
  });

  test("drops a top-level comment whose anchor is gone", () => {
    const kept = makeComment(1);
    const orphan = makeComment(2);
    expect(pruneOrphanedComments([kept, orphan], new Set([1]))).toEqual([kept]);
  });

  test("keeps a reply when its parent is still anchored", () => {
    const parent = makeComment(1);
    const reply = makeComment(2, 1);
    expect(pruneOrphanedComments([parent, reply], new Set([1]))).toEqual([
      parent,
      reply,
    ]);
  });

  test("drops a reply when the parent has been orphaned", () => {
    const orphanedParent = makeComment(1);
    const reply = makeComment(2, 1);
    expect(pruneOrphanedComments([orphanedParent, reply], new Set())).toEqual(
      [],
    );
  });

  test("drops a reply with no matching parent", () => {
    const replyOnly = makeComment(2, 999);
    expect(pruneOrphanedComments([replyOnly], new Set([2]))).toEqual([]);
  });

  test("returns an empty array when no top-level comments are anchored", () => {
    const a = makeComment(1);
    const b = makeComment(2, 1);
    expect(pruneOrphanedComments([a, b], new Set([7]))).toEqual([]);
  });
});
