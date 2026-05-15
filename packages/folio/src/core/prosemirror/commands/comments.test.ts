import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import {
  acceptAIEditRevision,
  findChangeAtPosition,
  findNextChange,
  findPreviousChange,
  rejectAIEditRevision,
} from "./comments";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: { marks: "_" },
  },
  marks: {
    insertion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["del", 0],
    },
  },
});

const REV_A_ATTRS = { revisionId: 1, author: "AI", date: "2026-01-01" };
const REV_B_ATTRS = { revisionId: 2, author: "AI", date: "2026-01-02" };

const makeStateWithMarks = () => {
  // One paragraph with two NON-overlapping insertion spans —
  // revision A's "alpha" then revision B's "beta", separated by a
  // plain word. Acting on revision A must leave "beta" and its
  // mark untouched; the previous resolveChange ignored the
  // revision id and processed every insertion mark in the range.
  const insertion = schema.marks["insertion"];
  return EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("alpha", [insertion.create(REV_A_ATTRS)]),
        schema.text(" middle "),
        schema.text("beta", [insertion.create(REV_B_ATTRS)]),
      ]),
    ]),
  });
};

const dispatcher = (state: EditorState) => {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
};

const insertionRevisionsAt = (state: EditorState): number[] => {
  const ids: number[] = [];
  state.doc.descendants((node) => {
    if (!node.isText) {
      return;
    }
    for (const mark of node.marks) {
      if (mark.type.name === "insertion") {
        ids.push(mark.attrs["revisionId"] as number);
      }
    }
  });
  return ids;
};

describe("AI revision accept/reject scoping", () => {
  test("acceptAIEditRevision only touches marks for the matching revisionId", () => {
    const view = dispatcher(makeStateWithMarks());

    expect(insertionRevisionsAt(view.state)).toEqual([1, 2]);

    const ok = acceptAIEditRevision(REV_A_ATTRS.revisionId)(
      view.state,
      view.dispatch,
    );

    expect(ok).toBe(true);
    // After accepting revision A, revision B's mark must still be
    // present — the user hasn't acted on it yet.
    expect(insertionRevisionsAt(view.state)).toEqual([2]);
  });

  test("rejectAIEditRevision only deletes text covered by the matching revisionId", () => {
    const view = dispatcher(makeStateWithMarks());

    const ok = rejectAIEditRevision(REV_A_ATTRS.revisionId)(
      view.state,
      view.dispatch,
    );

    expect(ok).toBe(true);
    // Reject drops "alpha" (its inserted text) but must leave the
    // plain " middle " run and revision B's "beta" intact. The
    // remaining insertion mark belongs to revision B alone.
    expect(view.state.doc.textContent).toBe(" middle beta");
    expect(insertionRevisionsAt(view.state)).toEqual([2]);
  });
});

describe("findChangeAtPosition", () => {
  test("returns the input range unchanged for a non-cursor selection", () => {
    const state = makeStateWithMarks();
    expect(findChangeAtPosition(state, 3, 12)).toEqual({ from: 3, to: 12 });
  });

  test("returns the cursor as-is when no tracked-change marks exist nearby", () => {
    // Position 10 sits in the plain " middle " run between the two
    // insertion spans of `makeStateWithMarks`.
    const state = makeStateWithMarks();
    expect(findChangeAtPosition(state, 10, 10)).toEqual({
      from: 10,
      to: 10,
    });
  });

  test("expands a cursor inside a single tracked-change span to that span's full range", () => {
    // Cursor inside "alpha" (revision A) — expansion should cover the
    // whole inserted word. Paragraph offsets: 1..6 = "alpha".
    const state = makeStateWithMarks();
    expect(findChangeAtPosition(state, 3, 3)).toEqual({ from: 1, to: 6 });
  });

  test("expands across multiple adjacent text nodes that share the same mark instance", () => {
    // Three adjacent text nodes that all share the *same* insertion
    // mark — this comes up when the inserted span is formatted
    // unevenly (e.g., a bold word inside a tracked-change). The
    // expansion must reach both edges, not just one neighbouring
    // node on either side.
    const insertion = schema.marks["insertion"]!.create(REV_A_ATTRS);
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("one", [insertion]),
          schema.text("two", [insertion]),
          schema.text("three", [insertion]),
        ]),
      ]),
    });
    // "one" 1..4, "two" 4..7, "three" 7..12. Cursor in "two".
    expect(findChangeAtPosition(state, 5, 5)).toEqual({ from: 1, to: 12 });
  });

  test("does not bleed into an adjacent insertion that belongs to a different revisionId", () => {
    // Two insertions back-to-back, no plain text between them. Cursor
    // is in the FIRST insertion. The expansion must stop at the
    // boundary — accepting/rejecting one revision must not implicate
    // the other.
    const insertion = schema.marks["insertion"];
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("alpha", [insertion.create(REV_A_ATTRS)]),
          schema.text("beta", [insertion.create(REV_B_ATTRS)]),
        ]),
      ]),
    });
    // "alpha" occupies positions 1..6, "beta" positions 6..10.
    expect(findChangeAtPosition(state, 3, 3)).toEqual({ from: 1, to: 6 });
  });
});

describe("tracked change navigation", () => {
  test("findNextChange returns the nearest later change before wrapping", () => {
    const state = makeStateWithMarks();

    const result = findNextChange(state, 6);

    expect(result).toMatchObject({
      from: 14,
      to: 18,
      type: "insertion",
    });
  });

  test("findNextChange wraps only when there is no later change", () => {
    const state = makeStateWithMarks();

    const result = findNextChange(state, state.doc.content.size);

    expect(result).toMatchObject({
      from: 1,
      to: 6,
      type: "insertion",
    });
  });

  test("findPreviousChange returns the nearest earlier change before wrapping", () => {
    const state = makeStateWithMarks();

    const result = findPreviousChange(state, 12);

    expect(result).toMatchObject({
      from: 1,
      to: 6,
      type: "insertion",
    });
  });

  test("findPreviousChange wraps only when there is no earlier change", () => {
    const state = makeStateWithMarks();

    const result = findPreviousChange(state, 0);

    expect(result).toMatchObject({
      from: 14,
      to: 18,
      type: "insertion",
    });
  });
});
