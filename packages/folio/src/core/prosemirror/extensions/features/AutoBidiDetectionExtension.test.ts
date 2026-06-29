/**
 * Tests for AutoBidiDetectionExtension.
 *
 * Contract: an "auto-managed" paragraph (direction undecided, or previously
 * auto-set as `{ source: "auto" }`) whose first strong character is RTL gets
 * `{ source: "auto" }`, both on load (`ensureBaseDirectionInState`) and on live
 * edits (`appendTransaction`). Detection includes inline field display text and
 * ignores deleted text. A manual decision (`{ source: "manual" }`, from a user
 * toggle or import) is never overridden, and an auto-set value is re-evaluated
 * when the text changes.
 */

import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import type { ParagraphDirection } from "../../paragraphDirection";
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
      attrs: { direction: { default: null } },
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
    // Inline content control holding nested inline content (mirrors inline SDT).
    inlineSdt: {
      group: "inline",
      inline: true,
      content: "text*",
      toDOM: () => ["span", 0],
    },
    text: { group: "inline" },
  },
  marks: {
    // Deleted / moved-away text carries this mark (mirrors the real schema).
    deletion: { toDOM: () => ["del", 0] },
  },
});

const runtime = AutoBidiDetectionExtension().onSchemaReady({ schema });
const plugin = runtime.plugins?.[0];
if (!plugin) {
  throw new Error("Expected plugin from AutoBidiDetectionExtension");
}

const para = (text: string, direction: ParagraphDirection | null = null) =>
  schema.node(
    "paragraph",
    { direction },
    text.length > 0 ? [schema.text(text)] : [],
  );

// Paragraph led by a field atom whose display text is `fieldText`.
const fieldLedPara = (fieldText: string, trailing: string) =>
  schema.node("paragraph", { direction: null }, [
    schema.node("field", { displayText: fieldText }),
    ...(trailing.length > 0 ? [schema.text(trailing)] : []),
  ]);

// Paragraph whose only content is an inline content control holding `text`.
const sdtLedPara = (text: string) =>
  schema.node("paragraph", { direction: null }, [
    schema.node("inlineSdt", null, text.length > 0 ? [schema.text(text)] : []),
  ]);

const stateOf = (...paras: PMNode[]) =>
  EditorState.create({
    doc: schema.node("doc", null, paras),
    plugins: [plugin],
  });

// A state built WITHOUT the plugin models a manager that disabled the extension.
const stateWithoutPlugin = (...paras: PMNode[]) =>
  EditorState.create({ doc: schema.node("doc", null, paras) });

// Compact, assertion-friendly tag for a paragraph's direction.
const dirTag = (direction: ParagraphDirection | null): string => {
  if (direction == null) {
    return "none";
  }
  if (direction.source === "auto") {
    return "auto";
  }
  return direction.value; // "rtl" | "ltr"
};

const dirs = (state: EditorState): string[] => {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "paragraph") {
      out.push(dirTag(node.attrs["direction"]));
    }
    return false;
  });
  return out;
};

const RTL = { source: "manual", value: "rtl" } as const;
const LTR = { source: "manual", value: "ltr" } as const;

describe("ensureBaseDirectionInState (initial load)", () => {
  test("auto-sets an Arabic-led paragraph", () => {
    expect(dirs(ensureBaseDirectionInState(stateOf(para("هذا عقد"))))).toEqual([
      "auto",
    ]);
  });

  test("leaves a Latin-led paragraph undecided", () => {
    expect(
      dirs(ensureBaseDirectionInState(stateOf(para("Agreement")))),
    ).toEqual(["none"]);
  });

  test("is a no-op when the extension is disabled (plugin absent)", () => {
    expect(
      dirs(ensureBaseDirectionInState(stateWithoutPlugin(para("هذا عقد")))),
    ).toEqual(["none"]);
  });

  test("does not override a manual LTR on Arabic text", () => {
    expect(
      dirs(ensureBaseDirectionInState(stateOf(para("عربي", LTR)))),
    ).toEqual(["ltr"]);
  });

  test("leaves a manual RTL paragraph untouched (idempotent)", () => {
    expect(
      dirs(ensureBaseDirectionInState(stateOf(para("عربي", RTL)))),
    ).toEqual(["rtl"]);
  });

  test("mixed: detects per paragraph", () => {
    const state = ensureBaseDirectionInState(
      stateOf(para("English"), para("نص عربي"), para("123 only")),
    );
    expect(dirs(state)).toEqual(["none", "auto", "none"]);
  });

  test("detects RTL from an inline field's display text", () => {
    const state = ensureBaseDirectionInState(stateOf(fieldLedPara("عربي", "")));
    expect(dirs(state)).toEqual(["auto"]);
  });

  test("detects RTL from text inside an inline content control (SDT)", () => {
    const state = ensureBaseDirectionInState(stateOf(sdtLedPara("عربي")));
    expect(dirs(state)).toEqual(["auto"]);
  });

  test("ignores deleted (non-live) text when detecting direction", () => {
    const paragraph = schema.node("paragraph", { direction: null }, [
      schema.text("عربي", [schema.mark("deletion")]),
      schema.text(" agreement"),
    ]);
    expect(dirs(ensureBaseDirectionInState(stateOf(paragraph)))).toEqual([
      "none",
    ]);
  });
});

describe("appendTransaction (live editing)", () => {
  test("typing Arabic into an empty paragraph auto-sets RTL", () => {
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("مرحبا", 1));
    expect(dirs(state)).toEqual(["auto"]);
  });

  test("typing Latin leaves the paragraph undecided", () => {
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("hello", 1));
    expect(dirs(state)).toEqual(["none"]);
  });

  test("does not re-flip a paragraph the user set to manual LTR", () => {
    let state = stateOf(para("عربي", LTR));
    state = state.apply(state.tr.insertText(" مزيد", 5));
    expect(dirs(state)).toEqual(["ltr"]);
  });

  test("re-evaluates an auto-set value when the text changes (no sticky RTL)", () => {
    let state = stateOf(para(""));
    state = state.apply(state.tr.insertText("مرحبا", 1));
    expect(dirs(state)).toEqual(["auto"]);
    // Replace all of it with Latin -> the auto value is cleared, not sticky.
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.replaceWith(1, end, schema.text("hello")));
    expect(dirs(state)).toEqual(["none"]);
  });

  test("does not re-evaluate a manual RTL set on Latin text", () => {
    let state = stateOf(para("Hello", RTL));
    state = state.apply(state.tr.insertText(" world", 6));
    expect(dirs(state)).toEqual(["rtl"]);
  });

  test("detects the edited paragraph in a multi-paragraph doc (scoped scan)", () => {
    let state = stateOf(para("First"), para(""));
    state = state.apply(
      state.tr.insertText("مرحبا", state.doc.content.size - 1),
    );
    expect(dirs(state)).toEqual(["none", "auto"]);
  });

  test("selection-only transactions do not allocate", () => {
    let state = stateOf(para("Agreement"));
    state = state.apply(state.tr.setSelection(state.selection));
    expect(dirs(state)).toEqual(["none"]);
  });
});
