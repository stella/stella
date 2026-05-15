import { describe, expect, test } from "bun:test";

import type { Comment } from "../../types/content";
import { serializeComments } from "./commentSerializer";

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
            content: [{ type: "text", text: "body" }],
          },
        ],
      },
    ],
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

describe("serializeComments", () => {
  test("emits a valid empty <w:comments/> document when the array is empty", () => {
    // Previously returned the empty string, which is not valid OOXML.
    // Save paths now overwrite the original `word/comments.xml` part
    // even when the editor has zero comments — that requires the
    // serializer to produce a well-formed empty document so the part
    // can be replaced rather than skipped.
    const xml = serializeComments([]);
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<w:comments xmlns:");
    expect(xml).toContain("</w:comments>");
    // No `<w:comment>` children.
    expect(xml).not.toContain("<w:comment ");
  });

  test("emits top-level comments before replies", () => {
    const reply = makeComment(2, 1);
    const top = makeComment(1);
    // Caller may pass replies first; the serializer must group them
    // after the top-level comments.
    const xml = serializeComments([reply, top]);
    const topIndex = xml.indexOf('w:id="1"');
    const replyIndex = xml.indexOf('w:id="2"');
    expect(topIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(-1);
    expect(topIndex).toBeLessThan(replyIndex);
  });
});
