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
  test("keeps top-level comments regardless of anchor status", () => {
    const comments = [makeComment(1), makeComment(2)];
    expect(pruneOrphanedComments(comments, new Set([1, 2]))).toEqual(comments);
  });

  test("keeps a top-level comment whose anchor was deleted (cannot distinguish from a parser-missed reply)", () => {
    // We don't drop unanchored top-level comments: the parser does
    // not yet read `commentsExtended.xml` to restore `parentId` on
    // Word replies, so an unanchored top-level entry might be an
    // imported reply masquerading as a root. Erring on the side of
    // preserving data — losing a Word reply on first save is strictly
    // worse than re-emitting a comment whose anchor was deleted.
    const kept = makeComment(1);
    const unanchoredTopLevel = makeComment(2);
    expect(
      pruneOrphanedComments([kept, unanchoredTopLevel], new Set([1])),
    ).toEqual([kept, unanchoredTopLevel]);
  });

  test("keeps a reply when its parent is still present", () => {
    const parent = makeComment(1);
    const reply = makeComment(2, 1);
    expect(pruneOrphanedComments([parent, reply], new Set([1]))).toEqual([
      parent,
      reply,
    ]);
  });

  test("keeps replies whose explicit parent exists, even when the parent's anchor was deleted", () => {
    // Top-level entries are kept whether or not they are anchored, so
    // replies pointing to them are kept too.
    const parent = makeComment(1);
    const reply = makeComment(2, 1);
    expect(pruneOrphanedComments([parent, reply], new Set())).toEqual([
      parent,
      reply,
    ]);
  });

  test("drops a reply whose explicit parent doesn't exist", () => {
    // A reply with an explicit `parentId` that points at no comment
    // we know about is a genuine broken-thread orphan — the only
    // kind we can identify confidently.
    const replyOnly = makeComment(2, 999);
    expect(pruneOrphanedComments([replyOnly], new Set([2]))).toEqual([]);
  });

  test("keeps a reply-to-a-reply when the root top-level comment exists", () => {
    // Threads can nest more than one level — a reply to a reply must
    // ride along when the root is present, not get pruned because its
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
    // never created. The chain doesn't reach a top-level comment in
    // the array, so the whole branch goes.
    const reply3 = makeComment(3, 2);
    const reply4 = makeComment(4, 3);
    expect(pruneOrphanedComments([reply3, reply4], new Set([2]))).toEqual([]);
  });

  test("preserves imported Word replies that arrive with parentId undefined", () => {
    // The OOXML parser does not yet populate `parentId` from
    // `commentsExtended.xml`, so Word replies look identical to
    // top-level comments without anchors. Dropping them on save —
    // the previous behaviour — silently loses every Word reply on
    // the first save. Keep them.
    const anchoredParent = makeComment(1);
    const unparsedReplyA = makeComment(2);
    const unparsedReplyB = makeComment(3);
    expect(
      pruneOrphanedComments(
        [anchoredParent, unparsedReplyA, unparsedReplyB],
        new Set([1]),
      ),
    ).toEqual([anchoredParent, unparsedReplyA, unparsedReplyB]);
  });
});
