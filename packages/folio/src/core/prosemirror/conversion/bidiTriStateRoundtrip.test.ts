/**
 * `fromProseDoc` maps the paragraph `direction` discriminated union to the
 * serialized OOXML `w:bidi` tri-state: a manual RTL/LTR decision becomes
 * `true`/`false` (the latter as `<w:bidi w:val="0"/>`), and an undecided
 * paragraph is omitted.
 *
 * Regression guard: a manual LTR (forced via setLtr) must survive save/reload as
 * `bidi: false`; if it collapsed to "undecided", the seed auto-detector would
 * re-flip an Arabic paragraph back to RTL. These tests lock the conversion end
 * to end (PM direction → model → serialized XML).
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import { serializeParagraph } from "../../docx/serializer/paragraphSerializer";
import type { Document } from "../../types/document";
import type { ParagraphDirection } from "../paragraphDirection";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const RTL: ParagraphDirection = { source: "manual", value: "rtl" };
const LTR: ParagraphDirection = { source: "manual", value: "ltr" };

const paraNode = (text: string, direction: ParagraphDirection | null) =>
  schema.node("doc", null, [
    schema.node("paragraph", { direction }, [schema.text(text)]),
  ]);

const firstParagraphBidi = (doc: Document): unknown => {
  const block = doc.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("expected a paragraph");
  }
  return block.formatting?.bidi;
};

describe("fromProseDoc direction → bidi (new paragraphs, no original)", () => {
  test("manual LTR becomes bidi=false (not dropped)", () => {
    expect(firstParagraphBidi(fromProseDoc(paraNode("عربي", LTR)))).toBe(false);
  });

  test("manual RTL becomes bidi=true", () => {
    expect(firstParagraphBidi(fromProseDoc(paraNode("عربي", RTL)))).toBe(true);
  });

  test("undecided is omitted", () => {
    expect(
      firstParagraphBidi(fromProseDoc(paraNode("Agreement", null))),
    ).toBeUndefined();
  });
});

describe("fromProseDoc direction → bidi (changed vs original)", () => {
  // An imported RTL paragraph that the user forces to LTR: the direction now
  // differs from the original, which is where the old truthiness check dropped
  // the explicit `false`.
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
      { ...pmDoc.child(0).attrs, direction: LTR },
    ).doc;

    expect(firstParagraphBidi(fromProseDoc(forcedLtr, original))).toBe(false);
  });
});

describe("pageBreakBefore tri-state (same class, fallback path)", () => {
  test("explicit pageBreakBefore=false is preserved on a new paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { pageBreakBefore: false }, [
        schema.text("Body"),
      ]),
    ]);
    const block = fromProseDoc(doc).package.document.content.at(0);
    if (block?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    expect(block.formatting?.pageBreakBefore).toBe(false);
  });
});

describe("manual LTR survives serialization (save invariant)", () => {
  test('direction=manual ltr serializes as <w:bidi w:val="0"/>', () => {
    const block = fromProseDoc(
      paraNode("عربي", LTR),
    ).package.document.content.at(0);
    if (block?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    expect(serializeParagraph(block)).toContain('<w:bidi w:val="0"/>');
  });
});
