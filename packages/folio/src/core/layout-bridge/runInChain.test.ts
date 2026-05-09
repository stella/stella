import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "../layout-engine/types";
import { schema } from "../prosemirror/schema";
import { toFlowBlocks } from "./toFlowBlocks";

// Run-in heading chains (`<w:specVanish/>` on the paragraph mark of
// every heading in a sequence). Word collapses the whole chain into
// the first body paragraph that lacks specVanish — see ECMA-376
// §17.3.1.32 and Codex's PR #258 review.
//
// `mergeRunInParagraphs` must keep folding while the merged block
// still carries `runInWithNext`. A previous version stopped after one
// fold, so chained run-in headings followed by body produced two
// visual lines instead of one.

describe("toFlowBlocks — chained run-in heading paragraphs", () => {
  test("two consecutive run-in headings merge with the body paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { runInWithNext: true }, [
        schema.text("Heading A"),
      ]),
      schema.node("paragraph", { runInWithNext: true }, [
        schema.text(" Heading B"),
      ]),
      schema.node("paragraph", null, [
        schema.text(". Body text continues here."),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);

    // All three paragraphs should collapse into a single block.
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.length).toBe(1);

    const merged = paragraphs[0] as ParagraphBlock;
    // Combined runs preserve the document order.
    const text = merged.runs
      .filter((r) => r.kind === "text")
      .map((r) => (r as { text?: string }).text ?? "")
      .join("");
    expect(text).toBe("Heading A Heading B. Body text continues here.");
    // The merged block does not carry `runInWithNext` — the chain
    // terminates at the body paragraph that lacks specVanish.
    expect(merged.attrs?.runInWithNext).toBeUndefined();
  });

  test("single run-in heading still merges with the next paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { runInWithNext: true }, [
        schema.text("Severability"),
      ]),
      schema.node("paragraph", null, [schema.text(". The invalidity ...")]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.length).toBe(1);
  });

  test("run-in heading at end-of-doc with no following paragraph stays standalone", () => {
    // Defensive: a doc that ends with a specVanish paragraph (no
    // body to merge with) must still emit one paragraph block.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { runInWithNext: true }, [
        schema.text("Trailing heading"),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.length).toBe(1);
  });
});
