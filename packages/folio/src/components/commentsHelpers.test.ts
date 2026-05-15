import { describe, expect, test } from "bun:test";

import type { Comment } from "../core/types/content";
import {
  collectCommentIdsFromSources,
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

describe("collectCommentIdsFromSources", () => {
  test("returns an empty set for content with no comment markers", () => {
    const content = [
      {
        type: "paragraph",
        content: [{ type: "run", content: [{ type: "text", text: "hi" }] }],
      },
    ];
    expect(collectCommentIdsFromSources(content)).toEqual(new Set());
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
    expect(collectCommentIdsFromSources(content)).toEqual(new Set([1, 2]));
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
    expect(collectCommentIdsFromSources(content)).toEqual(new Set([42]));
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
    expect(collectCommentIdsFromSources(content)).toEqual(new Set());
  });

  test("unions ids from multiple sources (body + headers + footnotes + endnotes)", () => {
    // Real saves pass several subtrees — comments anchored in headers,
    // footers, footnotes, or endnotes must all be discovered or they
    // would be pruned away.
    const body = [
      {
        type: "paragraph",
        content: [{ type: "commentRangeStart", id: 1 }],
      },
    ];
    const headers = new Map([
      [
        "rId1",
        {
          content: [
            {
              type: "paragraph",
              content: [{ type: "commentRangeStart", id: 10 }],
            },
          ],
        },
      ],
    ]);
    const footnotes = [
      {
        content: [
          {
            type: "paragraph",
            content: [{ type: "commentReference", id: 20 }],
          },
        ],
      },
    ];
    const endnotes = [
      {
        content: [
          {
            type: "paragraph",
            content: [{ type: "commentRangeEnd", id: 30 }],
          },
        ],
      },
    ];
    expect(
      collectCommentIdsFromSources(body, headers, footnotes, endnotes),
    ).toEqual(new Set([1, 10, 20, 30]));
  });

  test("walks Map containers (e.g., headers/footers keyed by relationship id)", () => {
    const headers = new Map([
      [
        "rId7",
        {
          content: [
            {
              type: "paragraph",
              content: [{ type: "commentRangeStart", id: 99 }],
            },
          ],
        },
      ],
    ]);
    expect(collectCommentIdsFromSources(headers)).toEqual(new Set([99]));
  });

  test("tolerates null and undefined source slots", () => {
    expect(collectCommentIdsFromSources(undefined, null)).toEqual(new Set());
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

  test("keeps a reply-to-a-reply when the root top-level comment is anchored", () => {
    // Threads can nest more than one level — a reply to a reply must
    // ride along when the root is anchored, not get pruned because its
    // immediate parent isn't a top-level comment.
    const root = makeComment(1);
    const reply = makeComment(2, 1);
    const replyToReply = makeComment(3, 2);
    expect(
      pruneOrphanedComments([root, reply, replyToReply], new Set([1])),
    ).toEqual([root, reply, replyToReply]);
  });

  test("drops the whole branch when an intermediate reply has no surviving root", () => {
    // Reply 4 points to reply 3, which points to a parent 2 that was
    // never created. The chain doesn't reach an anchored top-level,
    // so the whole branch goes.
    const reply3 = makeComment(3, 2);
    const reply4 = makeComment(4, 3);
    expect(pruneOrphanedComments([reply3, reply4], new Set([2]))).toEqual([]);
  });
});
