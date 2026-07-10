import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

import { hasContentBefore } from "@/components/chat/prompt-slash-extension";

// Minimal schema mirroring the real composer's shape closely enough to
// exercise `hasContentBefore`: a block doc, plain text, and a leaf `chip`
// node standing in for the real mention / pasted-text chip nodes (both
// declared `group: "inline", inline: true, atom: true`, no content -- see
// `chat-pasted-text-extension.ts`).
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    chip: { group: "inline", inline: true, atom: true },
  },
});

const makeDoc = (children: PMNode[]) =>
  schema.node("doc", null, [schema.node("paragraph", null, children)]);

describe("hasContentBefore", () => {
  test("an empty paragraph has no content", () => {
    const doc = makeDoc([]);
    expect(hasContentBefore(doc, doc.content.size)).toBe(false);
  });

  test("plain text counts as content", () => {
    const doc = makeDoc([schema.text("hello")]);
    expect(hasContentBefore(doc, doc.content.size)).toBe(true);
  });

  test("whitespace-only text counts as content, matching editor.isEmpty (not a trim heuristic)", () => {
    const doc = makeDoc([schema.text("   ")]);
    expect(hasContentBefore(doc, doc.content.size)).toBe(true);
  });

  test("an atom chip alone counts as content", () => {
    // A `textBetween` + `.trim()` check would reduce this chip to its
    // leaf-text placeholder and read the paragraph as empty -- the bug
    // this helper fixes.
    const doc = makeDoc([schema.node("chip")]);
    expect(hasContentBefore(doc, doc.content.size)).toBe(true);
  });

  test("only counts content before the cut point", () => {
    const chip = schema.node("chip");
    const doc = makeDoc([chip, schema.text("hello")]);
    // Position 1 enters the paragraph; the chip is a leaf node (size 1),
    // so this is the point right after it -- where "/" typed immediately
    // after a chip would trigger.
    const posRightAfterChip = 1 + chip.nodeSize;

    expect(hasContentBefore(doc, posRightAfterChip)).toBe(true);
    // Before the chip (still inside the empty paragraph start), there is
    // nothing yet.
    expect(hasContentBefore(doc, 1)).toBe(false);
  });
});
