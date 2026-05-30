/**
 * Image-tracked-change behaviour in suggesting mode and the accept/reject
 * resolver. Port of eigenpal docx-editor #641.
 *
 * Uses the real folio schema (not a minimal local one) because the new
 * behaviour hinges on `Image.nodeSpec.marks = "_"` and the schema's
 * `allowsMarkType` checks — a minimal schema can't exercise either.
 */

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import {
  acceptAIEditRevision,
  findNextChange,
  rejectAIEditRevision,
} from "../commands/comments";
import { schema } from "../schema";
import { createSuggestionModePlugin } from "./suggestionMode";

const PNG_DATA_URL = "data:image/png;base64,AA==";

function makeImageDoc(markName?: "insertion" | "deletion"): PMNode {
  // SAFETY: real editor schema has image, paragraph, and doc nodes.
  const image = schema.nodes["image"]!.create({
    src: PNG_DATA_URL,
    width: 80,
    height: 60,
  });
  const node = markName
    ? image.mark(
        schema.marks[markName]!.create({
          revisionId: 700,
          author: "Reviewer",
          date: "2026-05-30T00:00:00Z",
        }).addToSet(image.marks),
      )
    : image;
  const paragraph = schema.nodes["paragraph"]!.create({}, [node]);
  return schema.nodes["doc"]!.create({}, [paragraph]);
}

function countMarkedImages(
  state: EditorState,
  markName: "insertion" | "deletion",
): number {
  let count = 0;
  state.doc.descendants((node) => {
    if (
      node.type.name === "image" &&
      node.marks.some((m) => m.type.name === markName)
    ) {
      count += 1;
    }
    return true;
  });
  return count;
}

function countImages(state: EditorState): number {
  let count = 0;
  state.doc.descendants((node) => {
    if (node.type.name === "image") {
      count += 1;
    }
    return true;
  });
  return count;
}

describe("suggesting-mode catch-all marks pasted/dropped image (eigenpal #641)", () => {
  test("a plain insertText-style transaction in suggesting mode marks text", () => {
    // Regression guard for the dual `isText || allowsMarkType` arm: dropping
    // the text short-circuit would silently stop tracking pasted text.
    const plugin = createSuggestionModePlugin(true, "Jane");
    const doc = schema.nodes["doc"]!.create({}, [
      schema.nodes["paragraph"]!.create({}, [schema.text("hi")]),
    ]);
    let state = EditorState.create({ doc, plugins: [plugin] });

    // Plain insertion transaction — not via the suggestionMode handler.
    state = state.apply(state.tr.insertText("XY", 3));

    let xyMarked = false;
    state.doc.descendants((node) => {
      if (node.isText && node.text === "XY") {
        xyMarked = node.marks.some((m) => m.type.name === "insertion");
      }
      return true;
    });
    expect(xyMarked).toBe(true);
  });

  test("a programmatic image insert in suggesting mode auto-marks the image as inserted", () => {
    const plugin = createSuggestionModePlugin(true, "Jane");
    const doc = schema.nodes["doc"]!.create({}, [
      schema.nodes["paragraph"]!.create({}, [schema.text("hi")]),
    ]);
    let state = EditorState.create({ doc, plugins: [plugin] });

    const image = schema.nodes["image"]!.create({
      src: PNG_DATA_URL,
      width: 40,
      height: 40,
    });
    state = state.apply(state.tr.insert(3, image));

    expect(countMarkedImages(state, "insertion")).toBe(1);
  });
});

describe("accept / reject on a tracked image (eigenpal #641)", () => {
  test("accept on an inserted image keeps the image and strips the mark", () => {
    const doc = makeImageDoc("insertion");
    const state = EditorState.create({ doc });

    let nextState = state;
    acceptAIEditRevision(700)(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(countImages(nextState)).toBe(1);
    expect(countMarkedImages(nextState, "insertion")).toBe(0);
  });

  test("reject on an inserted image removes the image entirely", () => {
    const doc = makeImageDoc("insertion");
    const state = EditorState.create({ doc });

    let nextState = state;
    rejectAIEditRevision(700)(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(countImages(nextState)).toBe(0);
  });

  test("accept on a deleted image removes the image entirely", () => {
    const doc = makeImageDoc("deletion");
    const state = EditorState.create({ doc });

    let nextState = state;
    acceptAIEditRevision(700)(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(countImages(nextState)).toBe(0);
  });

  test("reject on a deleted image keeps the image and strips the mark", () => {
    const doc = makeImageDoc("deletion");
    const state = EditorState.create({ doc });

    let nextState = state;
    rejectAIEditRevision(700)(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(countImages(nextState)).toBe(1);
    expect(countMarkedImages(nextState, "deletion")).toBe(0);
  });

  test("findNextChange finds an image-only insertion (currently skipped pre-#641)", () => {
    // An atomic image carrying an insertion mark must surface in the
    // find-next walk; widening the visitor from isText to isInline is the
    // entire fix.
    const doc = makeImageDoc("insertion");
    const state = EditorState.create({ doc });
    const range = findNextChange(state, 0);
    expect(range).not.toBeNull();
    expect(range?.type).toBe("insertion");
  });

  test("findNextChange surfaces a deleted image too", () => {
    const doc = makeImageDoc("deletion");
    const state = EditorState.create({ doc });
    const range = findNextChange(state, 0);
    expect(range).not.toBeNull();
    expect(range?.type).toBe("deletion");
  });
});
