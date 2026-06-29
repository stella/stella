/**
 * Tests for AutoBidiDetectionExtension.
 *
 * Contract: an "auto-managed" paragraph (bidi unset, or previously auto-set via
 * `bidiAuto`) whose first strong character is RTL gets `bidi: true` + the
 * ephemeral `bidiAuto: true`, both on load (`ensureBaseDirectionInState`) and on
 * live edits (`appendTransaction`). Detection includes inline field display
 * text. An explicit decision (user toggle / import, `bidiAuto` cleared) is never
 * overridden, and an auto-set value is re-evaluated when the text changes.
 */

import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import {
  AutoBidiDetectionExtension,
  ensureBaseDirectionInState,
} from "./AutoBidiDetectionExtension";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { bidi: { default: null }, bidiAuto: { default: null } },
      toDOM: () => ["p", 0],
    },
    // Inline atom whose rendered text lives in attrs (mirrors the real field).
    field: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { displayText: { default: "" } },
      toDOM: () => ["span", 0],
    },
    text: { group: "inline" },
  },
});

const runtime = AutoBidiDetectionExtension().onSchemaReady({ schema });
const plugin = runtime.plugins?.[0];
if (!plugin) {
  throw new Error("Expected plugin from AutoBidiDetectionExtension");
}

type ParaAttrs = { bidi?: boolean | null; bidiAuto?: boolean | null };

const para = (text: string, attrs: ParaAttrs = {}) =>
  schema.node(
    "paragraph",
    { bidi: attrs.bidi ?? null, bidiAuto: attrs.bidiAuto ?? null },
    text.length > 0 ? [schema.text(text)] : [],
  );

// Paragraph led by a field atom whose display text is `fieldText`.
const fieldLedPara = (fieldText: string, trailing: string) =>
  schema.node("paragraph", { bidi: null, bidiAuto: null }, [
    schema.node("field", { displayText: fieldText }),
    ...(trailing.length > 0 ? [schema.text(trailing)] : []),
  ]);

const stateOf = (...paras: PMNode[]) =>
  EditorState.create({
    doc: schema.node("doc", null, paras),
    plugins: [plugin],
  });

// A state built WITHOUT the plugin models a manager that disabled the extension.
const stateWithoutPlugin = (...paras: PMNode[]) =>
  EditorState.create({ doc: schema.node("doc", null, paras) });

const bidis = (state: EditorState): (boolean | null)[] => {
  const out: (boolean | null)[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "paragraph") {
      out.push(node.attrs["bidi"] as boolean | null);
    }
    return false;
  });
  return out;
};

describe("ensureBaseDirectionInState (initial load)", () => {
  test("sets bidi=true on an Arabic-led paragraph", () => {
    expect(bidis(ensureBaseDirectionInState(stateOf(para("هذا عقد"))))).toEqual(
      [true],
    );
  });

  test("leaves a Latin-led paragraph undecided", () => {
    expect(
      bidis(ensureBaseDirectionInState(stateOf(para("Agreement")))),
    ).toEqual([null]);
  });

  test("is a no-op when the extension is disabled (plugin absent)", () => {
    // Respects `disable: ["autoBidiDetection"]`: no bidi injected on seed.
    expect(
      bidis(ensureBaseDirectionInState(stateWithoutPlugin(para("هذا عقد")))),
    ).toEqual([null]);
  });

  test("does not override an explicit LTR (false) on Arabic text", () => {
    expect(
      bidis(ensureBaseDirectionInState(stateOf(para("عربي", { bidi: false })))),
    ).toEqual([false]);
  });

  test("leaves an already-RTL paragraph as true (idempotent)", () => {
    expect(
      bidis(ensureBaseDirectionInState(stateOf(para("عربي", { bidi: true })))),
    ).toEqual([true]);
  });

  test("mixed: detects per paragraph", () => {
    const state = ensureBaseDirectionInState(
      stateOf(para("English"), para("نص عربي"), para("123 only")),
    );
    expect(bidis(state)).toEqual([null, true, null]);
  });

  test("detects RTL from an inline field's display text", () => {
    // node.textContent omits the field atom; detection must fold in displayText.
    const state = ensureBaseDirectionInState(stateOf(fieldLedPara("عربي", "")));
    expect(bidis(state)).toEqual([true]);
  });
});

describe("appendTransaction (live editing)", () => {
  test("typing Arabic into an empty paragraph sets bidi=true", () => {
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("مرحبا", 1));
    expect(bidis(state)).toEqual([true]);
  });

  test("typing Latin leaves bidi undecided", () => {
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("hello", 1));
    expect(bidis(state)).toEqual([null]);
  });

  test("does not re-flip a paragraph the user set to explicit LTR", () => {
    // Arabic paragraph the user forced to LTR (false, bidiAuto cleared); a
    // further edit must not re-detect it back to RTL.
    let state = stateOf(para("عربي", { bidi: false }));
    state = state.apply(state.tr.insertText(" مزيد", 5));
    expect(bidis(state)).toEqual([false]);
  });

  test("re-evaluates an auto-set value when the text changes (no sticky RTL)", () => {
    // Type Arabic into an empty paragraph -> auto RTL.
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("مرحبا", 1));
    expect(bidis(state)).toEqual([true]);
    // Replace all of it with Latin -> the auto value is cleared, not sticky.
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.replaceWith(1, end, schema.text("hello")));
    expect(bidis(state)).toEqual([null]);
  });

  test("does not re-evaluate a manual RTL set on Latin text", () => {
    // User explicitly set RTL (bidiAuto cleared) on Latin content; editing must
    // leave the explicit decision intact.
    let state = stateOf(para("Hello", { bidi: true, bidiAuto: null }));
    state = state.apply(state.tr.insertText(" world", 6));
    expect(bidis(state)).toEqual([true]);
  });

  test("selection-only transactions do not allocate", () => {
    let state = stateOf(para("Agreement"));
    state = state.apply(state.tr.setSelection(state.selection));
    expect(bidis(state)).toEqual([null]);
  });
});
