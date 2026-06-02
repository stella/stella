/**
 * Regression tests for the empty-paragraph formatting fix (eigenpal #657).
 *
 * Bug 1: applying a heading to an empty paragraph then typing produced
 *        unstyled text — the style picker's refocus cleared the stored
 *        marks before the first keystroke. EmptyParagraphFormatExtension
 *        re-derives them from the paragraph's `defaultTextFormatting`.
 *
 * Bug 2: pressing Enter at the end of a heading kept the heading style;
 *        it should drop to the style's `w:next` (body text).
 */

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { createEmptyDocument } from "../../../utils/createDocument";
import { createDocumentStylesPlugin } from "../../plugins/documentStyles";
import { singletonManager, schema } from "../../schema";
import { createStyleResolver } from "../../styles/styleResolver";
import { splitBlockClearBorders } from "./BaseKeymapExtension";

const resolver = createStyleResolver(createEmptyDocument().package.styles);

function markNames(
  marks: readonly { type: { name: string } }[] | null,
): string[] {
  return (marks ?? []).map((m) => m.type.name);
}

function stateWith(doc: PMNode, withResolver = true): EditorState {
  const plugins = [...singletonManager.getPlugins()];
  if (withResolver) {
    plugins.push(createDocumentStylesPlugin(resolver));
  }
  return EditorState.create({ doc, schema, plugins });
}

describe("EmptyParagraphFormatExtension", () => {
  test("re-derives stored marks from a heading paragraph defaultTextFormatting", () => {
    const heading = schema.node("paragraph", {
      styleId: "Heading1",
      defaultTextFormatting: {
        fontSize: 40,
        bold: true,
        fontFamily: { ascii: "Arial", hAnsi: "Arial" },
      },
    });
    let state = stateWith(schema.node("doc", null, [heading]));

    // A selection change (mimicking the dropdown refocus) clears stored
    // marks; the plugin must put them back so typed text inherits the
    // heading.
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );

    expect(markNames(state.storedMarks)).toContain("bold");
    expect(markNames(state.storedMarks)).toContain("fontSize");
  });

  test("leaves a plain body paragraph mark-free (font/size handled by the painter)", () => {
    const body = schema.node("paragraph", {
      defaultTextFormatting: {
        fontSize: 22,
        fontFamily: { ascii: "Arial", hAnsi: "Arial" },
      },
    });
    let state = stateWith(schema.node("doc", null, [body]));
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );

    // No bold/color/etc. → no stored marks forced onto ordinary typed text.
    expect(state.storedMarks).toBeNull();
  });
});

describe("splitBlockClearBorders — w:next style switch", () => {
  // Build a heading paragraph with text, place the cursor at its end, run
  // the editor's Enter handler (`splitBlockClearBorders`), and capture the
  // transaction. The new (second) paragraph should now carry the heading
  // style's `w:next` style.
  function splitAtEndOfHeading(withResolver: boolean): Transaction {
    const heading = schema.node(
      "paragraph",
      {
        styleId: "Heading1",
        defaultTextFormatting: { fontSize: 40, bold: true },
      },
      [schema.text("Heading One")],
    );
    let state = stateWith(schema.node("doc", null, [heading]), withResolver);
    const headingNode = state.doc.firstChild;
    if (!headingNode) {
      throw new Error("Expected heading paragraph");
    }
    const endOfHeading = headingNode.nodeSize - 1;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, endOfHeading)),
    );

    const captured: { tr: Transaction | null } = { tr: null };
    splitBlockClearBorders(state, (tr) => {
      captured.tr = tr;
    });
    if (!captured.tr) {
      throw new Error("Enter handler did not produce a transaction");
    }
    return captured.tr;
  }

  test("Enter after a heading switches the new paragraph to the next style", () => {
    const tr = splitAtEndOfHeading(true);
    const newPara = tr.doc.child(1);
    expect(newPara.attrs["styleId"]).toBe("Normal");
    // Heading spacing should be dropped (Normal has no spaceBefore).
    expect(newPara.attrs["spaceBefore"]).toBeNull();
    // Stored marks should come from Normal's run formatting (no bold).
    expect(markNames(tr.storedMarks)).not.toContain("bold");
  });

  test("without a resolver the new paragraph inherits the source heading style", () => {
    const tr = splitAtEndOfHeading(false);
    expect(tr.doc.child(1).attrs["styleId"]).toBe("Heading1");
  });

  test("mid-paragraph split before an inline atom keeps the heading style", () => {
    // Regression: textContent.length === 0 was incorrectly true for a
    // paragraph carrying only an inline atom (image/equation/field/etc.),
    // which made a mid-paragraph split apply w:next and silently demote the
    // atom-bearing half to Normal. Use a hard_break as the simplest inline
    // non-text node to reproduce the condition.
    const heading = schema.node(
      "paragraph",
      {
        styleId: "Heading1",
        defaultTextFormatting: { fontSize: 40, bold: true },
      },
      [schema.text("Title"), schema.node("hardBreak")],
    );
    let state = stateWith(schema.node("doc", null, [heading]));
    // Cursor between "Title" and the hard_break (offset 6 inside the doc:
    // 1 for paragraph open + 5 text chars).
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6)),
    );

    const captured: { tr: Transaction | null } = { tr: null };
    splitBlockClearBorders(state, (tr) => {
      captured.tr = tr;
    });
    if (!captured.tr) {
      throw new Error("Enter handler did not produce a transaction");
    }

    const trailingPara = captured.tr.doc.child(1);
    expect(trailingPara.content.size).toBeGreaterThan(0);
    // Old buggy behavior would set this to "Normal"; w:next must not fire
    // for a mid-paragraph split.
    expect(trailingPara.attrs["styleId"]).toBe("Heading1");
  });
});
