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
    // `bold` is here so a single tracked-change span can be split into
    // two adjacent text nodes that share the *same* insertion mark
    // instance but differ in inline formatting — ProseMirror does not
    // merge text nodes whose mark sets differ, so this is the only
    // way to construct a genuinely multi-node tracked change.
    bold: { toDOM: () => ["strong", 0] },
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

  // A tracked-change span split into two text nodes that share the *same*
  // insertion mark instance but differ in inline formatting — exactly
  // what happens when a user partially bolds inside an AI suggestion.
  // The navigation buttons must select the WHOLE inserted span, not
  // just the first text node — otherwise pressing "next change" leaves
  // the second half outside the selection and follow-up accept/reject
  // actions miss it.
  const makeMultiNodeSameRevisionState = () => {
    const insertion = schema.marks["insertion"]!.create(REV_A_ATTRS);
    const bold = schema.marks["bold"]!.create();
    return EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("plain"),
          schema.text("bold", [insertion, bold]),
          schema.text("plain", [insertion]),
          schema.text(" tail"),
        ]),
      ]),
    });
  };

  test("findNextChange spans the full multi-node tracked change", () => {
    // Paragraph offsets: "plain" 1..6, "bold" 6..10 (ins+bold),
    // "plain" 10..15 (ins), " tail" 15..20. Starting before the
    // change, "next" must select the whole inserted region 6..15.
    const state = makeMultiNodeSameRevisionState();
    expect(findNextChange(state, 0)).toMatchObject({
      from: 6,
      to: 15,
      type: "insertion",
    });
  });

  test("findPreviousChange spans the full multi-node tracked change", () => {
    // Starting from beyond the change, "previous" must also select
    // the whole inserted region 6..15.
    const state = makeMultiNodeSameRevisionState();
    expect(findPreviousChange(state, 20)).toMatchObject({
      from: 6,
      to: 15,
      type: "insertion",
    });
  });
});
