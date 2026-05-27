/**
 * Unit tests for ParaIdAllocatorExtension.
 *
 * The plugin is lifted from eigenpal upstream (Apache-2.0). These
 * tests cover the contract we rely on downstream: every paragraph
 * ends up with a non-empty `paraId` and no two paragraphs share one,
 * including after paste-style Slice insertions that import a
 * paragraph carrying an id that already exists in the doc.
 */

import { describe, test, expect } from "bun:test";
import { Schema, Slice, Fragment } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import { ParaIdAllocatorExtension } from "./ParaIdAllocatorExtension";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: {
        paraId: { default: null },
        textId: { default: null },
      },
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

const ext = ParaIdAllocatorExtension();
const runtime = ext.onSchemaReady({ schema });
const plugin = runtime.plugins?.[0];
if (!plugin) {
  throw new Error("Expected plugin from ParaIdAllocatorExtension");
}

const para = (text: string, paraId: string | null = null) =>
  schema.node(
    "paragraph",
    { paraId },
    text.length > 0 ? [schema.text(text)] : [],
  );

const createState = (...paras: ReturnType<typeof para>[]) =>
  EditorState.create({
    doc: schema.node("doc", null, paras),
    plugins: [plugin],
  });

const collectParaIds = (state: EditorState): (string | null)[] => {
  const out: (string | null)[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "paragraph") {
      const id = node.attrs["paraId"];
      out.push(typeof id === "string" ? id : null);
      return false;
    }
    return true;
  });
  return out;
};

describe("ParaIdAllocatorExtension", () => {
  test("does not allocate on a selection-only transaction", () => {
    const initial = createState(para("Already has one", "ABCDEFGH"));
    const tr = initial.tr.setMeta("anything", true); // no doc change
    const next = initial.apply(tr);
    expect(collectParaIds(next)).toEqual(["ABCDEFGH"]);
  });

  test("allocates an 8-char hex id for a paragraph that lacks one", () => {
    const initial = createState(para("Needs an id"));
    // Insert a character to trigger a doc-change transaction and let
    // the appendTransaction hook fire.
    const next = initial.apply(initial.tr.insertText("!", 11));
    const ids = collectParaIds(next);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9A-F]{8}$/u);
  });

  test("re-assigns a fresh id when a paragraph is inserted with a duplicate id", () => {
    const initial = createState(para("Original", "ABCDEFGH"));
    // Simulate paste: insert a paragraph node that carries the same
    // paraId as one already in the doc.
    const dupe = para("Pasted", "ABCDEFGH");
    const tr = initial.tr.replace(
      initial.doc.content.size,
      initial.doc.content.size,
      new Slice(Fragment.from(dupe), 0, 0),
    );
    const next = initial.apply(tr);
    const ids = collectParaIds(next);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("ABCDEFGH");
    expect(ids[1]).toMatch(/^[0-9A-F]{8}$/u);
    expect(ids[1]).not.toBe("ABCDEFGH");
  });

  test("preserves existing distinct ids untouched", () => {
    const initial = createState(
      para("First", "11111111"),
      para("Second", "22222222"),
    );
    // Trigger any doc-changed transaction.
    const next = initial.apply(initial.tr.insertText("!", 6));
    expect(collectParaIds(next)).toEqual(["11111111", "22222222"]);
  });
});
