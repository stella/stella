/**
 * Tests for AutoBidiDetectionExtension.
 *
 * Contract: a paragraph whose direction is undecided (`bidi == null`) and whose
 * first strong character is RTL gets `bidi: true` — both when seeded on load
 * (`ensureBaseDirectionInState`) and when content is inserted live
 * (`appendTransaction`). An explicit decision (`true`/`false`) is never
 * overridden, and Latin-led paragraphs are left untouched.
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
      attrs: { bidi: { default: null } },
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

const runtime = AutoBidiDetectionExtension().onSchemaReady({ schema });
const plugin = runtime.plugins?.[0];
if (!plugin) {
  throw new Error("Expected plugin from AutoBidiDetectionExtension");
}

const para = (text: string, bidi: boolean | null = null) =>
  schema.node(
    "paragraph",
    { bidi },
    text.length > 0 ? [schema.text(text)] : [],
  );

const stateOf = (...paras: PMNode[]) =>
  EditorState.create({
    doc: schema.node("doc", null, paras),
    plugins: [plugin],
  });

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

  test("does not override an explicit LTR (false) on Arabic text", () => {
    expect(
      bidis(ensureBaseDirectionInState(stateOf(para("عربي", false)))),
    ).toEqual([false]);
  });

  test("leaves an already-RTL paragraph as true (idempotent)", () => {
    expect(
      bidis(ensureBaseDirectionInState(stateOf(para("عربي", true)))),
    ).toEqual([true]);
  });

  test("mixed: detects per paragraph", () => {
    const state = ensureBaseDirectionInState(
      stateOf(para("English"), para("نص عربي"), para("123 only")),
    );
    expect(bidis(state)).toEqual([null, true, null]);
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
    // Arabic paragraph the user forced to LTR (false); a further edit must not
    // re-detect it back to RTL.
    let state = stateOf(para("عربي", false));
    state = state.apply(state.tr.insertText(" مزيد", 5));
    expect(bidis(state)).toEqual([false]);
  });

  test("selection-only transactions do not allocate", () => {
    let state = stateOf(para("Agreement"));
    state = state.apply(state.tr.setSelection(state.selection));
    expect(bidis(state)).toEqual([null]);
  });
});
