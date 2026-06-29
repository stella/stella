/**
 * The paragraph `bidi` attribute is tri-state: true (RTL), false (explicit LTR,
 * serialized as `<w:bidi w:val="0"/>`), and null/undefined (undecided — eligible
 * for auto-detection). `fromProseDoc` must preserve an explicit `false` rather
 * than collapse it into "undecided" via a truthiness check.
 *
 * Regression guard: previously `if (attrs.bidi)` dropped `false`, so a forced-LTR
 * Arabic paragraph lost `<w:bidi w:val="0"/>` on save; on reload the seed
 * auto-detector saw `null` again and re-flipped it back to RTL. These tests lock
 * the full save invariant end to end (model → serialized XML).
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import { serializeParagraph } from "../../docx/serializer/paragraphSerializer";
import type { Document } from "../../types/document";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const paraNode = (text: string, bidi: boolean | null) =>
  schema.node("doc", null, [
    schema.node("paragraph", { bidi }, [schema.text(text)]),
  ]);

const firstParagraphBidi = (doc: Document): unknown => {
  const block = doc.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("expected a paragraph");
  }
  return block.formatting?.bidi;
};

describe("fromProseDoc bidi tri-state (new paragraphs, no original)", () => {
  test("explicit LTR (false) is preserved, not dropped", () => {
    const out = fromProseDoc(paraNode("عربي", false));
    expect(firstParagraphBidi(out)).toBe(false);
  });

  test("explicit RTL (true) is preserved", () => {
    const out = fromProseDoc(paraNode("عربي", true));
    expect(firstParagraphBidi(out)).toBe(true);
  });

  test("undecided (null) is omitted", () => {
    const out = fromProseDoc(paraNode("Agreement", null));
    expect(firstParagraphBidi(out)).toBeUndefined();
  });
});

describe("fromProseDoc bidi tri-state (changed vs original)", () => {
  // The real bug: a paragraph imported without bidi (or auto-detected RTL) that
  // the user forces to LTR. The PM attr (false) now differs from the original,
  // which is exactly where the old truthiness check deleted it.
  test("RTL original forced to LTR keeps bidi=false", () => {
    const original: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              formatting: { bidi: true },
              content: [
                { type: "run", content: [{ type: "text", text: "عربي" }] },
              ],
            },
          ],
        },
      },
    };
    const pmDoc = toProseDoc(original);
    const forcedLtr = EditorState.create({ doc: pmDoc }).tr.setNodeMarkup(
      0,
      undefined,
      { ...pmDoc.child(0).attrs, bidi: false },
    ).doc;

    const out = fromProseDoc(forcedLtr, original);
    expect(firstParagraphBidi(out)).toBe(false);
  });
});

describe("explicit LTR survives serialization (save invariant)", () => {
  test('bidi=false serializes as <w:bidi w:val="0"/>', () => {
    const out = fromProseDoc(paraNode("عربي", false));
    const block = out.package.document.content.at(0);
    if (block?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    expect(serializeParagraph(block)).toContain('<w:bidi w:val="0"/>');
  });
});
