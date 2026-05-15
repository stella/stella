import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import {
  acceptAIEditRevision,
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
