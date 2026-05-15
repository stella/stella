import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";

import {
  detectActiveTrackedChange,
  detectImageContext,
} from "./selectionDetection";

// Minimal schema covering the bits the detection helpers care about:
//  - an `image` node (so NodeSelection wraps it)
//  - `insertion` / `deletion` marks (tracked-change detection)
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        wrapType: { default: "inline" },
        displayMode: { default: "inline" },
        cssFloat: { default: null },
        transform: { default: null },
        alt: { default: null },
        borderWidth: { default: null },
        borderColor: { default: null },
        borderStyle: { default: null },
      },
      toDOM: () => ["img"],
    },
  },
  marks: {
    insertion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      toDOM: () => ["del", 0],
    },
  },
});

function paragraphState(text: string): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
  return EditorState.create({ doc });
}

function withCursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos)),
  );
}

describe("detectImageContext", () => {
  test("returns null when the selection is a plain text cursor", () => {
    const state = paragraphState("hello world");
    expect(detectImageContext(withCursorAt(state, 3))).toBeNull();
  });

  test("returns null when the selected node is not an image", () => {
    // Paragraph node is not an image — a NodeSelection of it should also miss.
    const state = paragraphState("hi");
    // Select the paragraph as a NodeSelection (position 0).
    const ns = NodeSelection.create(state.doc, 0);
    const withParaSelected = state.apply(state.tr.setSelection(ns));
    expect(detectImageContext(withParaSelected)).toBeNull();
  });

  test("returns the attrs as ImageContextInfo when an image is selected", () => {
    const imageNode = schema.nodes["image"]!.create({
      wrapType: "float",
      displayMode: "block",
      cssFloat: "right",
      transform: "rotate(15deg)",
      alt: "alt text",
      borderWidth: 2,
      borderColor: "var(--test-border)",
      borderStyle: "dashed",
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [imageNode]),
    ]);
    const initial = EditorState.create({ doc });
    // The image is the only inline child at position 1 (inside the paragraph).
    const state = initial.apply(
      initial.tr.setSelection(NodeSelection.create(initial.doc, 1)),
    );

    expect(detectImageContext(state)).toEqual({
      pos: 1,
      wrapType: "float",
      displayMode: "block",
      cssFloat: "right",
      transform: "rotate(15deg)",
      alt: "alt text",
      borderWidth: 2,
      borderColor: "var(--test-border)",
      borderStyle: "dashed",
    });
  });

  test("falls back to defaults when image attrs are absent", () => {
    const imageNode = schema.nodes["image"]!.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [imageNode]),
    ]);
    const initial = EditorState.create({ doc });
    const state = initial.apply(
      initial.tr.setSelection(NodeSelection.create(initial.doc, 1)),
    );

    expect(detectImageContext(state)).toEqual({
      pos: 1,
      wrapType: "inline",
      displayMode: "inline",
      cssFloat: null,
      transform: null,
      alt: null,
      borderWidth: null,
      borderColor: null,
      borderStyle: null,
    });
  });
});

describe("detectActiveTrackedChange", () => {
  function paragraphWithMark(
    markName: "insertion" | "deletion",
    attrs: { author?: string; date?: string; revisionId?: number },
    text = "redlined",
  ): EditorState {
    const mark = schema.marks[markName]!.create({
      author: attrs.author ?? "",
      date: attrs.date ?? "",
      revisionId: attrs.revisionId ?? 1,
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(text, [mark])]),
    ]);
    return EditorState.create({ doc });
  }

  test("returns null when the cursor is on plain text", () => {
    const state = paragraphState("hello");
    expect(detectActiveTrackedChange(withCursorAt(state, 3))).toBeNull();
  });

  test("returns the insertion context when the cursor is on an inserted run", () => {
    const state = withCursorAt(
      paragraphWithMark("insertion", {
        author: "Alice",
        date: "2026-05-15T17:00:00Z",
      }),
      3,
    );
    expect(detectActiveTrackedChange(state)).toEqual({
      type: "insertion",
      author: "Alice",
      date: "2026-05-15T17:00:00Z",
      from: 1,
      to: 9,
    });
  });

  test("returns the deletion context when the cursor is on a deleted run", () => {
    const state = withCursorAt(
      paragraphWithMark("deletion", { author: "Bob" }),
      2,
    );
    expect(detectActiveTrackedChange(state)).toEqual({
      type: "deletion",
      author: "Bob",
      date: null,
      from: 1,
      to: 9,
    });
  });

  test('uses "Unknown" / null when author and date attrs are empty', () => {
    const state = withCursorAt(paragraphWithMark("insertion", {}), 2);
    expect(detectActiveTrackedChange(state)).toEqual({
      type: "insertion",
      author: "Unknown",
      date: null,
      from: 1,
      to: 9,
    });
  });
});
