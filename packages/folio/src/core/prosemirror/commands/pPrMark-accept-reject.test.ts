import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import {
  acceptAllChanges,
  acceptChange,
  rejectAllChanges,
  rejectChange,
} from "./comments";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: { pPrMark: { default: null } },
    },
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

const dispatcher = (state: EditorState) => {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
};

const insMark = (info: { id: number; author?: string }) => ({
  kind: "ins" as const,
  info: { id: info.id, author: info.author ?? "Alice" },
});

const delMark = (info: { id: number; author?: string }) => ({
  kind: "del" as const,
  info: { id: info.id, author: info.author ?? "Alice" },
});

const twoParagraphs = (firstPPrMark: unknown) =>
  EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", { pPrMark: firstPPrMark }, schema.text("first")),
      schema.node("paragraph", null, schema.text("second")),
    ]),
  });

describe("pPrMark accept / reject — paragraph-mark resolution", () => {
  test("accept clears pPrMark.kind = 'ins' (the paragraph break stays)", () => {
    const view = dispatcher(twoParagraphs(insMark({ id: 1 })));
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(0).textContent).toBe("first");
    expect(view.state.doc.child(1).textContent).toBe("second");
  });

  test("reject of pPrMark.kind = 'ins' joins this paragraph with the next", () => {
    const view = dispatcher(twoParagraphs(insMark({ id: 1 })));
    rejectAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });

  test("accept of pPrMark.kind = 'del' joins this paragraph with the next", () => {
    const view = dispatcher(twoParagraphs(delMark({ id: 1 })));
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });

  test("reject clears pPrMark.kind = 'del' (the paragraph break stays)", () => {
    const view = dispatcher(twoParagraphs(delMark({ id: 1 })));
    rejectAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(0).textContent).toBe("first");
    expect(view.state.doc.child(1).textContent).toBe("second");
  });

  test("range-scoped acceptChange ignores paragraphs outside the range", () => {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node(
          "paragraph",
          { pPrMark: insMark({ id: 1 }) },
          schema.text("p1"),
        ),
        schema.node(
          "paragraph",
          { pPrMark: insMark({ id: 2 }) },
          schema.text("p2"),
        ),
        schema.node("paragraph", null, schema.text("p3")),
      ]),
    });
    const view = dispatcher(state);

    // Range covers only the first paragraph (positions 0–3).
    acceptChange(0, 3)(view.state, view.dispatch);

    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(1).attrs["pPrMark"]).toEqual(
      insMark({ id: 2 }),
    );
  });

  test("acceptAll on a doc-terminal pPrMark='del' leaves the marker (no next sibling)", () => {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("first")),
        schema.node(
          "paragraph",
          { pPrMark: delMark({ id: 1 }) },
          schema.text("last"),
        ),
      ]),
    });
    const view = dispatcher(state);
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).attrs["pPrMark"]).toEqual(
      delMark({ id: 1 }),
    );
  });

  test("rejectChange + inline insertion on same paragraph resolves both", () => {
    const insertion = schema.marks["insertion"];
    if (!insertion) {
      throw new Error("schema lacks insertion mark");
    }
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", { pPrMark: insMark({ id: 1 }) }, [
          schema.text("kept "),
          schema.text("inserted", [
            insertion.create({
              revisionId: 1,
              author: "Alice",
              date: "2026-05-01",
            }),
          ]),
        ]),
        schema.node("paragraph", null, schema.text("next")),
      ]),
    });
    const view = dispatcher(state);

    rejectChange(0, view.state.doc.content.size)(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("kept next");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });
});
