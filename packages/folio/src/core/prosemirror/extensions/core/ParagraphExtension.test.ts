import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { toFlowBlocks } from "../../../layout-bridge/convert/toFlowBlocks";
import { AUTO_PARAGRAPH_SPACING_PX } from "../../../utils/units";
import { schema, singletonManager } from "../../schema";

const paragraphDomAttrs = (
  attrs: Record<string, unknown>,
): Record<string, string> => {
  const paragraph = schema.node("paragraph", attrs);
  const toDOM = paragraph.type.spec.toDOM;
  if (!toDOM) {
    throw new Error("Expected paragraph node to provide toDOM");
  }

  const domSpec = toDOM(paragraph) as [string, Record<string, string>, number];

  return domSpec[1];
};

describe("ParagraphExtension", () => {
  test("preserves explicit list paragraph left indent", () => {
    const attrs = paragraphDomAttrs({
      indentLeft: 1440,
      numPr: { ilvl: 0, numId: 1 },
    });

    expect(attrs["style"]).toContain("margin-left: 96px");
    expect(attrs["style"]).not.toContain("margin-left: 48px");
  });

  test("uses the synthetic list indent when left indent is null", () => {
    const attrs = paragraphDomAttrs({
      indentLeft: null,
      numPr: { ilvl: 1, numId: 1 },
    });

    expect(attrs["style"]).toContain("margin-left: 96px");
  });

  test("spacing edits make the DOM gate ignore imported auto-spacing (#823)", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          spaceBefore: 200,
          _originalFormatting: {
            beforeAutospacing: true,
            afterAutospacing: true,
          },
          _autospacingBase: { before: 200 },
        },
        [schema.text("x")],
      ),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1),
    });

    const setSpaceBefore = singletonManager.getCommand("setSpaceBefore");
    if (!setSpaceBefore) {
      throw new Error("Missing setSpaceBefore command");
    }
    setSpaceBefore(240)(state, (tr: Transaction) => {
      state = state.apply(tr);
    });

    const para = state.doc.firstChild;
    expect(para?.attrs["spaceBefore"]).toBe(240);
    const original = para?.attrs["_originalFormatting"] as
      | {
          beforeAutospacing?: boolean;
          afterAutospacing?: boolean;
          spaceBefore?: number;
        }
      | undefined;
    expect(original?.beforeAutospacing).toBe(true);
    expect(original?.afterAutospacing).toBe(true);
    expect(original?.spaceBefore).toBeUndefined();

    const domAttrs = paragraphDomAttrs(para?.attrs ?? {});
    expect(domAttrs["style"]).toContain("margin-top: 16px");
    expect(domAttrs["style"]).not.toContain(
      `margin-top: ${AUTO_PARAGRAPH_SPACING_PX}px`,
    );
  });

  test("applying a style with spacing overrides imported auto-spacing (#823)", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          spaceBefore: 200,
          _originalFormatting: {
            beforeAutospacing: true,
          },
          _autospacingBase: { before: 200 },
        },
        [schema.text("x")],
      ),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1),
    });

    const applyStyle = singletonManager.getCommand("applyStyle");
    if (!applyStyle) {
      throw new Error("Missing applyStyle command");
    }
    applyStyle("Spaced", {
      paragraphFormatting: { spaceBefore: 360 },
    })(state, (tr: Transaction) => {
      state = state.apply(tr);
    });

    const para = state.doc.firstChild;
    expect(para?.attrs["styleId"]).toBe("Spaced");
    expect(para?.attrs["spaceBefore"]).toBe(360);

    const domAttrs = paragraphDomAttrs(para?.attrs ?? {});
    expect(domAttrs["style"]).toContain("margin-top: 24px");
    expect(domAttrs["style"]).not.toContain(
      `margin-top: ${AUTO_PARAGRAPH_SPACING_PX}px`,
    );

    const block = toFlowBlocks(state.doc).at(0);
    expect(block?.attrs?.spacing?.before).toBe(24);
  });

  test("applying a style without auto spacing clears the imported auto-spacing baseline (#823)", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          _originalFormatting: {
            beforeAutospacing: true,
          },
          _autospacingBase: { before: null },
        },
        [schema.text("x")],
      ),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1),
    });

    const applyStyle = singletonManager.getCommand("applyStyle");
    if (!applyStyle) {
      throw new Error("Missing applyStyle command");
    }
    applyStyle("Normal", {
      paragraphFormatting: {},
    })(state, (tr: Transaction) => {
      state = state.apply(tr);
    });

    const para = state.doc.firstChild;
    expect(para?.attrs["styleId"]).toBe("Normal");
    expect(para?.attrs["_autospacingBase"]).toBeNull();

    const domAttrs = paragraphDomAttrs(para?.attrs ?? {});
    expect(domAttrs["style"] ?? "").not.toContain(
      `margin-top: ${AUTO_PARAGRAPH_SPACING_PX}px`,
    );

    const block = toFlowBlocks(state.doc).at(0);
    expect(block?.attrs?.spacing?.before).not.toBe(AUTO_PARAGRAPH_SPACING_PX);
  });

  test("the DOM gate applies style-sourced auto spacing with no numeric baseline (#823)", () => {
    const domAttrs = paragraphDomAttrs({
      _originalFormatting: { styleId: "AutoSpacing" },
      _autospacingBase: { before: null },
    });

    expect(domAttrs["style"]).toContain(
      `margin-top: ${AUTO_PARAGRAPH_SPACING_PX}px`,
    );
  });
});
