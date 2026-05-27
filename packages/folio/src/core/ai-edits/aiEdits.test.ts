import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { applyFolioAIEditOperations } from "./apply";
import { createFolioAIEditSnapshot } from "./snapshot";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: {
        listMarker: { default: null },
        styleId: { default: null },
        // Identity attrs — must NOT be copied when a new block is
        // synthesized from a sibling, otherwise downstream tracking
        // sees duplicate IDs.
        paraId: { default: null },
        textId: { default: null },
        defaultTextFormatting: { default: null },
      },
    },
    text: {},
  },
  marks: {
    insertion: {
      attrs: {
        revisionId: {},
        author: {},
        date: {},
      },
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: {
        revisionId: {},
        author: {},
        date: {},
      },
      toDOM: () => ["del", 0],
    },
    comment: {
      attrs: {
        commentId: {},
      },
      toDOM: (mark) => [
        "span",
        { "data-comment-id": mark.attrs["commentId"] },
        0,
      ],
    },
    bold: {
      toDOM: () => ["strong", 0],
    },
    italic: {
      toDOM: () => ["em", 0],
    },
    fontSize: {
      attrs: {
        size: { default: 24 },
      },
      toDOM: (mark) => [
        "span",
        { style: `font-size: ${Number(mark.attrs["size"]) / 2}pt` },
        0,
      ],
    },
    fontFamily: {
      attrs: {
        ascii: { default: null },
        hAnsi: { default: null },
      },
      toDOM: () => ["span", 0],
    },
    underline: {
      attrs: {
        style: { default: "single" },
      },
      toDOM: () => ["u", 0],
    },
  },
});

type BlockSpec =
  | string
  | {
      text: string;
      listMarker?: string;
      paraId?: string;
      textId?: string;
    };

const makeState = (blocks: BlockSpec[]) =>
  EditorState.create({
    schema,
    doc: schema.node(
      "doc",
      null,
      blocks.map((block) => {
        const text = typeof block === "string" ? block : block.text;
        const attrs =
          typeof block === "string"
            ? {}
            : {
                listMarker: block.listMarker ?? null,
                paraId: block.paraId ?? null,
                textId: block.textId ?? null,
              };
        return schema.node(
          "paragraph",
          attrs,
          text.length === 0 ? [] : [schema.text(text)],
        );
      }),
    ),
  });

const makeView = (state: EditorState) => {
  const view = {
    state,
    dispatch(transaction: Transaction) {
      view.state = view.state.apply(transaction);
    },
  };
  return view;
};

/**
 * Helpers for the boundary tests below: build a single-paragraph
 * doc whose runs carry pre-existing tracked-change marks. Lets us
 * write declarative input like ["plain", ["del", "shall"], ["ins",
 * "must"], "plain"] instead of hand-rolling schema.text per call.
 */
type PreexistingRun = string | ["ins" | "del", string, number?]; // [kind, text, optional revisionId]

const makeTrackedDoc = (
  runs: PreexistingRun[],
): { state: EditorState; doc: ReturnType<typeof schema.node> } => {
  const insertionType = schema.marks["insertion"];
  const deletionType = schema.marks["deletion"];
  const date = "2026-01-01T00:00:00.000Z";
  const textNodes = runs.flatMap((run) => {
    if (typeof run === "string") {
      return run.length === 0 ? [] : [schema.text(run)];
    }
    const [kind, text, revisionId = 100] = run;
    if (text.length === 0) {
      return [];
    }
    const mark =
      kind === "ins"
        ? insertionType.create({ revisionId, author: "PriorUser", date })
        : deletionType.create({ revisionId, author: "PriorUser", date });
    return [schema.text(text, [mark])];
  });
  const doc = schema.node("doc", null, [
    schema.node("paragraph", {}, textNodes),
  ]);
  return { state: EditorState.create({ schema, doc }), doc };
};

const collectMarksByText = (state: EditorState): Record<string, string[]> => {
  const marksByText: Record<string, string[]> = {};
  state.doc.descendants((node) => {
    if (!node.isText) {
      return;
    }
    marksByText[node.text ?? ""] = node.marks.map((m) => m.type.name);
  });
  return marksByText;
};

describe("Folio AI edit operations", () => {
  test("creates a simple AI-facing block snapshot", () => {
    const state = makeState([
      "Opening paragraph.",
      { listMarker: "7.5.1", text: "Payment one." },
    ]);

    const snapshot = createFolioAIEditSnapshot(state.doc);

    expect(snapshot.blocks).toEqual([
      {
        id: "seq-0001",
        kind: "paragraph",
        text: "Opening paragraph.",
      },
      {
        id: "seq-0002",
        kind: "listItem",
        displayLabel: "7.5.1",
        text: "Payment one.",
      },
    ]);
    expect(snapshot.anchors["seq-0001"]?.textHash).toMatch(/^h/u);
  });

  test("captures formatted preview runs in the AI-facing block snapshot", () => {
    const boldType = schema.marks["bold"];
    const italicType = schema.marks["italic"];
    const fontSizeType = schema.marks["fontSize"];
    const fontFamilyType = schema.marks["fontFamily"];
    const underlineType = schema.marks["underline"];
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", {}, [
          schema.text("Plain "),
          schema.text("Styled", [
            boldType.create(),
            italicType.create(),
            underlineType.create({ style: "single" }),
            fontSizeType.create({ size: 28 }),
            fontFamilyType.create({ ascii: "Aptos", hAnsi: "Aptos" }),
          ]),
          schema.text(" No underline", [
            underlineType.create({ style: "none" }),
          ]),
        ]),
      ]),
    });

    const snapshot = createFolioAIEditSnapshot(state.doc);

    expect(snapshot.blocks[0]?.text).toBe("Plain Styled No underline");
    expect(snapshot.blocks[0]?.previewRuns).toEqual([
      { text: "Plain " },
      {
        text: "Styled",
        bold: true,
        italic: true,
        underline: true,
        fontFamily: "Aptos",
        fontSizePt: 14,
      },
      { text: " No underline" },
    ]);
  });

  test("does not render explicit underline none as a formatted preview run", () => {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node(
          "paragraph",
          { defaultTextFormatting: { underline: { style: "none" } } },
          [schema.text("Cleared underline")],
        ),
      ]),
    });

    const snapshot = createFolioAIEditSnapshot(state.doc);

    expect(snapshot.blocks[0]?.previewRuns).toBeUndefined();
  });

  test("applies safe replacements as tracked changes with an attached comment", () => {
    const view = makeView(makeState(["The buyer shall pay."]));
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "shall",
          replace: "must",
          comment: { text: "Modernised obligation wording." },
        },
      ],
      author: "AI",
      createCommentId: () => 42,
    });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "op-1", commentId: 42 });
    expect(typeof result.applied[0]?.revisionId).toBe("number");
    expect(result.skipped).toEqual([]);
    expect(view.state.doc.textContent).toBe("The buyer shallmust pay.");

    const marksByText: Record<string, string[]> = {};
    view.state.doc.descendants((node) => {
      if (!node.isText) {
        return;
      }
      marksByText[node.text ?? ""] = node.marks.map((mark) => mark.type.name);
    });
    expect(marksByText["shall"]).toContain("deletion");
    expect(marksByText["must"]).toContain("insertion");
    expect(marksByText["must"]).toContain("comment");
  });

  test("skips a replacement when the user changed the target block", () => {
    const originalState = makeState(["The buyer shall pay."]);
    const snapshot = createFolioAIEditSnapshot(originalState.doc);
    const view = makeView(makeState(["The buyer must pay."]));

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "shall",
          replace: "must",
        },
      ],
    });

    expect(result).toEqual({
      applied: [],
      skipped: [{ id: "op-1", reason: "changedBlock" }],
    });
    expect(view.state.doc.textContent).toBe("The buyer must pay.");
  });

  test("inserts a new block after a list item and inherits its marker attrs", () => {
    const view = makeView(
      makeState([{ listMarker: "7.5.1", text: "Payment one." }]),
    );
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "insertAfterBlock",
          blockId: "seq-0001",
          text: "Payment two.",
          inheritFormatting: true,
        },
      ],
      mode: "direct",
    });

    expect(result.skipped).toEqual([]);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).attrs["listMarker"]).toBe("7.5.1");
    expect(view.state.doc.child(1).textContent).toBe("Payment two.");
  });

  test("does not over-reject when another block shares the same text hash", () => {
    // The freshness gate must check the target block, not the
    // global count of matching hashes — a sibling with the same
    // text getting edited shouldn't skip an op on an unchanged
    // target.
    const originalState = makeState(["Payment.", "Payment.", "Other text."]);
    const snapshot = createFolioAIEditSnapshot(originalState.doc);
    const view = makeView(makeState(["Payment.", "Tweaked.", "Other text."]));

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "Payment",
          replace: "Charge",
        },
      ],
      mode: "direct",
    });

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(view.state.doc.firstChild?.textContent).toBe("Charge.");
  });

  test("survives an unrelated insertion before the target block", () => {
    // The resolver must locate the target block by its content
    // signature, not by the snapshot's raw absolute offset — async
    // insertions before the target shift every later position.
    const originalState = makeState(["First paragraph.", "Target paragraph."]);
    const snapshot = createFolioAIEditSnapshot(originalState.doc);
    // Live doc gained a new block at the top after the snapshot.
    const view = makeView(
      makeState([
        "Inserted before the snapshot was taken.",
        "First paragraph.",
        "Target paragraph.",
      ]),
    );

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0002",
          find: "Target",
          replace: "Renamed",
        },
      ],
      mode: "direct",
    });

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(view.state.doc.child(2).textContent).toBe("Renamed paragraph.");
  });

  test("paraId-anchored op resolves the right block when a same-text duplicate appears before it", () => {
    // Reproduces the chatgpt-codex review concern on #473: with
    // hash+ordinal-only lookup, a duplicate of the snapshot block's
    // text inserted BEFORE the target between snapshot and apply
    // would steal the ordinal and the op would mutate the wrong
    // block. The paraId-direct path keeps the lookup pinned to the
    // originally-referenced paragraph.
    const originalState = makeState([
      { text: "Other paragraph.", paraId: "10000000" },
      { text: "Payment.", paraId: "AAAA0001" },
    ]);
    const snapshot = createFolioAIEditSnapshot(originalState.doc);
    // Live doc has a NEW paragraph with the same text "Payment."
    // inserted BEFORE the original target. Hash+ordinal would now
    // bucket [insertedDup, originalTarget] under the same hash and
    // pick index 0 (the duplicate), mutating the wrong block.
    const view = makeView(
      makeState([
        { text: "Other paragraph.", paraId: "10000000" },
        { text: "Payment.", paraId: "BBBB0002" },
        { text: "Payment.", paraId: "AAAA0001" },
      ]),
    );

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "AAAA0001",
          find: "Payment",
          replace: "Charge",
        },
      ],
      mode: "direct",
    });

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    // The BBBB0002 block (live index 1) must stay untouched.
    expect(view.state.doc.child(1).textContent).toBe("Payment.");
    // The AAAA0001 block (live index 2) is the one that gets edited.
    expect(view.state.doc.child(2).textContent).toBe("Charge.");
  });

  test("applies multiple insertAfterBlock ops at the same position in document order", () => {
    // Same-position ops must apply in a deterministic, logical
    // order. Sorting by `from` alone is non-deterministic for
    // ties, and `tr.insert` shifts positions so a later op at the
    // same numeric `from` lands relative to the mutated doc, not
    // the original anchor.
    const view = makeView(makeState(["Anchor block."]));
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "insertAfterBlock",
          blockId: "seq-0001",
          text: "First inserted.",
        },
        {
          id: "op-2",
          type: "insertAfterBlock",
          blockId: "seq-0001",
          text: "Second inserted.",
        },
      ],
      mode: "direct",
    });

    expect(result.skipped).toEqual([]);
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.child(0).textContent).toBe("Anchor block.");
    // Logical order is op-1 first, op-2 second. The bottom-up
    // apply must preserve that.
    expect(view.state.doc.child(1).textContent).toBe("First inserted.");
    expect(view.state.doc.child(2).textContent).toBe("Second inserted.");
  });

  test("inheritFormatting does not copy identity attrs (paraId / textId)", () => {
    // The new block synthesized for an insertAfterBlock with
    // inheritFormatting must keep formatting attrs (listMarker,
    // styleId) from the source but NEVER reuse identity attrs —
    // duplicate paraId/textId values break tracked-change author
    // attribution and any consumer that keys off them.
    const view = makeView(
      makeState([
        {
          text: "Source paragraph.",
          listMarker: "1.",
          paraId: "para-source",
          textId: "text-source",
        },
      ]),
    );
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "insertAfterBlock",
          // Source paragraph carries `paraId: "para-source"`, so the
          // snapshot keys it as `b-para-source` (paraId-anchored).
          blockId: "para-source",
          text: "Inherited follow-up.",
          inheritFormatting: true,
        },
      ],
      mode: "direct",
    });

    expect(result.skipped).toEqual([]);
    const inserted = view.state.doc.child(1);
    expect(inserted.attrs["listMarker"]).toBe("1.");
    expect(inserted.attrs["paraId"]).toBeNull();
    expect(inserted.attrs["textId"]).toBeNull();
  });

  test("replaceBlock with preserveFormatting=false strips block-level attrs", () => {
    // `preserveFormatting=false` lets the model request "drop the
    // list marker, this is just plain text now". The flag is
    // exposed in the operation schema; honour it.
    const view = makeView(
      makeState([{ listMarker: "1.", text: "List item content." }]),
    );
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceBlock",
          blockId: "seq-0001",
          text: "Now just plain text.",
          preserveFormatting: false,
        },
      ],
      mode: "direct",
    });

    expect(result.skipped).toEqual([]);
    expect(view.state.doc.firstChild?.textContent).toBe("Now just plain text.");
    expect(view.state.doc.firstChild?.attrs["listMarker"]).toBeNull();
  });

  test("replaceBlock marks only diverging tokens, leaves shared runs untouched", () => {
    // The engine should produce a minimal diff: when most words are
    // unchanged, only the changed runs get insertion/deletion marks.
    // A coarse "mark whole block deletion + insert whole block"
    // would tag every shared word and is what we're guarding against.
    const view = makeView(
      makeState(["The buyer shall pay the seller within thirty days."]),
    );
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceBlock",
          blockId: "seq-0001",
          text: "The buyer must pay the seller within sixty days.",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    const marksByText: Record<string, string[]> = {};
    view.state.doc.descendants((node) => {
      if (!node.isText) {
        return;
      }
      marksByText[node.text ?? ""] = node.marks.map((mark) => mark.type.name);
    });
    // Shared tokens carry no tracked-change marks.
    for (const shared of ["The buyer ", " pay the seller within ", " days."]) {
      expect(marksByText[shared] ?? []).not.toContain("insertion");
      expect(marksByText[shared] ?? []).not.toContain("deletion");
    }
    // Diverging tokens carry exactly the right marks.
    expect(marksByText["shall"]).toContain("deletion");
    expect(marksByText["must"]).toContain("insertion");
    expect(marksByText["thirty"]).toContain("deletion");
    expect(marksByText["sixty"]).toContain("insertion");
  });

  test("snapshot and apply ignore existing tracked-change marks", () => {
    // The AI should see the post-tracked-changes view: existing
    // deletion-marked text is hidden, existing insertion-marked
    // text is included as plain text. Otherwise the model sees
    // "shallmust" smashed together and writes find/replace
    // operations against that confused string.
    //
    // Build a doc whose textContent is "The buyer shallmust pay."
    // (`shall` is a pending deletion, `must` is a pending insertion).
    const insertionMark = schema.marks["insertion"].create({
      revisionId: 1,
      author: "AI",
      date: "2026-01-01T00:00:00.000Z",
    });
    const deletionMark = schema.marks["deletion"].create({
      revisionId: 1,
      author: "AI",
      date: "2026-01-01T00:00:00.000Z",
    });
    const trackedDoc = schema.node("doc", null, [
      schema.node("paragraph", {}, [
        schema.text("The buyer "),
        schema.text("shall", [deletionMark]),
        schema.text("must", [insertionMark]),
        schema.text(" pay."),
      ]),
    ]);
    const view = makeView(EditorState.create({ schema, doc: trackedDoc }));

    const snapshot = createFolioAIEditSnapshot(view.state.doc);
    expect(snapshot.blocks[0]?.text).toBe("The buyer must pay.");

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "must",
          replace: "should",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    // The pending "shall" stays untouched, the pending "must" is
    // now marked deletion in addition to its existing insertion,
    // and "should" sits as the new insertion next to it.
    const marksByText: Record<string, string[]> = {};
    view.state.doc.descendants((node) => {
      if (!node.isText) {
        return;
      }
      marksByText[node.text ?? ""] = node.marks.map((mark) => mark.type.name);
    });
    expect(marksByText["shall"]).toContain("deletion");
    expect(marksByText["must"]).toContain("insertion");
    expect(marksByText["must"]).toContain("deletion");
    expect(marksByText["should"]).toContain("insertion");
  });

  test("AI edit at the start of clean text when block opens with a deletion run", () => {
    // Block live text: "old shall pay." with "old " marked
    // deletion. Clean view: "shall pay." — AI replaces at offset 0.
    // The find lookup must skip the leading deletion run, and the
    // resulting marks must land on the live "shall" position, not
    // the literal first character of the block.
    const { state } = makeTrackedDoc([["del", "old "], "shall pay."]);
    const view = makeView(state);
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    expect(snapshot.blocks[0]?.text).toBe("shall pay.");

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "shall",
          replace: "must",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    const marks = collectMarksByText(view.state);
    expect(marks["old "]).toContain("deletion");
    expect(marks["shall"]).toContain("deletion");
    expect(marks["must"]).toContain("insertion");
  });

  test("AI edit at the end of clean text when block ends with an insertion run", () => {
    // Block: "Pay " + ins "promptly." → clean view: "Pay promptly."
    // AI replaces "promptly" at the end. Marks must land on the
    // existing insertion run, stacking new del+ins on top.
    const { state } = makeTrackedDoc(["Pay ", ["ins", "promptly."]]);
    const view = makeView(state);
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    expect(snapshot.blocks[0]?.text).toBe("Pay promptly.");

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "promptly",
          replace: "immediately",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    const marks = collectMarksByText(view.state);
    // "promptly" was already an insertion, now also gets a deletion
    // mark from the new revision; the leading "Pay " stays clean.
    expect(marks["Pay "] ?? []).not.toContain("insertion");
    expect(marks["Pay "] ?? []).not.toContain("deletion");
    expect(marks["promptly"]).toContain("insertion");
    expect(marks["promptly"]).toContain("deletion");
    expect(marks["immediately"]).toContain("insertion");
  });

  test("AI edit spanning across an existing deletion run still resolves", () => {
    // Live runs: "The buyer " + del "shall " + ins "must " + "pay."
    // Clean view: "The buyer must pay." — AI replaces "buyer must"
    // with "seller should". The find spans across the (skipped)
    // "shall" deletion in the live doc; mark boundaries must use
    // the right PM positions and leave "shall" untouched.
    const { state } = makeTrackedDoc([
      "The buyer ",
      ["del", "shall "],
      ["ins", "must "],
      "pay.",
    ]);
    const view = makeView(state);
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    expect(snapshot.blocks[0]?.text).toBe("The buyer must pay.");

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "buyer must",
          replace: "seller should",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    // Find the node carrying the literal "shall " text (PM may
    // split or re-bucket text nodes after the new addMark calls,
    // so a direct lookup by full text isn't reliable).
    let shallNodeMarks: string[] | null = null;
    view.state.doc.descendants((node) => {
      if (
        node.isText &&
        node.text !== undefined &&
        node.text.includes("shall")
      ) {
        shallNodeMarks = node.marks.map((m) => m.type.name);
      }
    });
    expect(shallNodeMarks).not.toBeNull();
    // Pre-existing "shall" deletion is left intact (one deletion
    // mark, no insertion mark added on top by the new revision).
    const shallMarks: string[] = shallNodeMarks;
    expect(shallMarks.includes("deletion")).toBe(true);
    expect(shallMarks.includes("insertion")).toBe(false);
  });

  test("a single replace operation uses distinct revisionIds for ins vs del", () => {
    // fromProseDoc's DOCX writer treats any revisionId that appears
    // on BOTH an insertion mark AND a deletion mark in the doc as a
    // Word "move" (w:moveTo / w:moveFrom). For a plain replace
    // operation that's a misclassification — Word would render it
    // as a "moved from / moved to" pair instead of a strike-through
    // + new text. The engine must therefore allocate one revisionId
    // for the deletion side and a different one for the insertion
    // side of a single replace, so they serialise correctly.
    const view = makeView(makeState(["The buyer shall pay."]));
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "shall",
          replace: "must",
        },
      ],
    });

    const insertionIds = new Set<number>();
    const deletionIds = new Set<number>();
    view.state.doc.descendants((node) => {
      if (!node.isText) {
        return;
      }
      for (const mark of node.marks) {
        const id = Number(mark.attrs["revisionId"]);
        if (!Number.isFinite(id)) {
          continue;
        }
        if (mark.type.name === "insertion") {
          insertionIds.add(id);
        } else if (mark.type.name === "deletion") {
          deletionIds.add(id);
        }
      }
    });
    const overlap = [...insertionIds].filter((id) => deletionIds.has(id));
    expect(overlap).toEqual([]);
  });

  test("replaceInBlock on a tracked-changes block actually mutates the doc", () => {
    // Regression: when the block carries pending deletion runs,
    // the engine used to slice blockNode.textContent (which
    // includes the deleted chars) using PM positions from the
    // post-tracked-changes view (which doesn't). The mismatch
    // produced a diff with no PM steps, yet `applied[]` still
    // listed the op — a silent accept-failure where the panel
    // said "accepted" but the document didn't change. Lock in
    // that the op is either applied AND the doc mutated, or
    // skipped — never phantom-applied.
    const { state } = makeTrackedDoc([
      "The buyer ",
      ["del", "shall "],
      ["ins", "must "],
      "pay.",
    ]);
    const view = makeView(state);
    const docBefore = view.state.doc.toString();
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "must",
          replace: "should",
        },
      ],
    });

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(view.state.doc.toString()).not.toBe(docBefore);
  });

  test("filters no-op operations (find equals replace, replaceBlock equals current)", () => {
    // The model occasionally emits replaceInBlock with find ===
    // replace (verified in dev-tools trace). Skip with reason
    // "noopOperation" so the panel never shows X→X cards.
    const view = makeView(makeState(["Prodávající 3."]));
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceInBlock",
          blockId: "seq-0001",
          find: "Prodávající 3",
          replace: "Prodávající 3",
        },
        {
          id: "op-2",
          type: "replaceBlock",
          blockId: "seq-0001",
          text: "Prodávající 3.",
        },
      ],
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "op-1", reason: "noopOperation" },
      { id: "op-2", reason: "noopOperation" },
    ]);
  });

  test("two queued ops from one batch survive an in-between accept that mutates structure", () => {
    // Real-world flow: AI generates a single batch with three ops.
    // The user accepts them sequentially. The first accept inserts
    // a paragraph (insertAfterBlock), shifting all subsequent
    // block PM positions; the panel must still be able to resolve
    // ops 2 and 3 against the ORIGINAL snapshot via textHash
    // lookup. A fresh-snapshot-per-accept approach would break op
    // 3 because block ids would have re-numbered.
    const view = makeView(
      makeState([
        "Section 1 intro.",
        "Section 2 body.",
        "Section 3 conclusion.",
      ]),
    );
    const originalSnapshot = createFolioAIEditSnapshot(view.state.doc);

    // First op: insert a new paragraph after Section 1. This
    // structurally shifts Section 2 and Section 3 down.
    const r1 = applyFolioAIEditOperations({
      view,
      snapshot: originalSnapshot,
      operations: [
        {
          id: "op-1",
          type: "insertAfterBlock",
          blockId: "seq-0001",
          text: "Inserted aside.",
        },
      ],
      mode: "direct",
    });
    expect(r1.skipped).toEqual([]);
    expect(view.state.doc.childCount).toBe(4);

    // Second op references "seq-0002" in the ORIGINAL snapshot
    // (which was Section 2). After the insertion above, a fresh
    // snapshot would call Section 2 "seq-0003" — but we use the
    // original. The textHash lookup must find Section 2 at its
    // shifted position.
    const r2 = applyFolioAIEditOperations({
      view,
      snapshot: originalSnapshot,
      operations: [
        {
          id: "op-2",
          type: "replaceInBlock",
          blockId: "seq-0002",
          find: "Section 2",
          replace: "Section II",
        },
      ],
      mode: "direct",
    });
    expect(r2.skipped).toEqual([]);
    expect(r2.applied).toHaveLength(1);

    // Third op: also against original snapshot, targets Section 3.
    const r3 = applyFolioAIEditOperations({
      view,
      snapshot: originalSnapshot,
      operations: [
        {
          id: "op-3",
          type: "replaceInBlock",
          blockId: "seq-0003",
          find: "Section 3",
          replace: "Section III",
        },
      ],
      mode: "direct",
    });
    expect(r3.skipped).toEqual([]);
    expect(r3.applied).toHaveLength(1);

    expect(view.state.doc.child(0).textContent).toBe("Section 1 intro.");
    expect(view.state.doc.child(1).textContent).toBe("Inserted aside.");
    expect(view.state.doc.child(2).textContent).toBe("Section II body.");
    expect(view.state.doc.child(3).textContent).toBe("Section III conclusion.");
  });

  test("queued op resolves against the original snapshot after the doc shifts", () => {
    // Locks in why the panel must hand the apply engine the
    // ORIGINAL snapshot the AI saw, not a freshly recomputed one:
    //
    //   1. Block ids are sequential (b-0001, b-0002, ...). After
    //      an insertAfterBlock accept, every block below shifts +1.
    //   2. The resolver looks up blocks by `textHash` (content
    //      hash), not by id position. So as long as the target
    //      block's CONTENT hasn't changed since snapshot time,
    //      its hash bucket is unchanged and the lookup succeeds —
    //      even if its absolute PM position moved.
    //   3. A fresh snapshot would re-number the target as a
    //      different id (e.g. b-0003 → b-0004), and the queued
    //      op's blockId="seq-0003" would either miss or hit the
    //      wrong block.
    const view = makeView(
      makeState(["Alpha block.", "Bravo block.", "Charlie block."]),
    );
    const originalSnapshot = createFolioAIEditSnapshot(view.state.doc);

    // Mutate the doc by inserting a new block above Charlie. This
    // shifts Charlie's PM offset but leaves its text (and thus
    // hash) untouched.
    applyFolioAIEditOperations({
      view,
      snapshot: originalSnapshot,
      operations: [
        {
          id: "ins-1",
          type: "insertAfterBlock",
          blockId: "seq-0001",
          text: "Inserted after Alpha.",
        },
      ],
      mode: "direct",
    });
    expect(view.state.doc.childCount).toBe(4);

    // A fresh snapshot would call Charlie "seq-0004" now; the
    // ORIGINAL snapshot still calls it "seq-0003". Apply an op
    // referencing the original id — must succeed against the
    // mutated doc.
    const result = applyFolioAIEditOperations({
      view,
      snapshot: originalSnapshot,
      operations: [
        {
          id: "op-charlie",
          type: "replaceInBlock",
          blockId: "seq-0003",
          find: "Charlie",
          replace: "Delta",
        },
      ],
      mode: "direct",
    });

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(view.state.doc.lastChild?.textContent).toBe("Delta block.");
  });

  test("snapshot omits a block whose entire content is deletion-marked", () => {
    // After the user accepts the deletion the block becomes empty
    // anyway, so the AI has nothing useful to anchor against.
    // Today the snapshot just skips it (zero-length normalized
    // text). Locks in that behaviour.
    const { state } = makeTrackedDoc([["del", "Entire block is gone."]]);
    const snapshot = createFolioAIEditSnapshot(state.doc);
    expect(snapshot.blocks).toHaveLength(0);
  });

  test("word-level diff works for non-Latin scripts split on whitespace", () => {
    // Czech / German / French / Polish all split on whitespace, so
    // the same LCS path applies — only the diverging Czech token
    // should carry tracked-change marks. Locks in that the regex
    // tokeniser handles diacritics without pre/post-processing.
    const view = makeView(
      makeState(["Kupující musí zaplatit do třiceti dnů."]),
    );
    const snapshot = createFolioAIEditSnapshot(view.state.doc);

    const result = applyFolioAIEditOperations({
      view,
      snapshot,
      operations: [
        {
          id: "op-1",
          type: "replaceBlock",
          blockId: "seq-0001",
          text: "Kupující musí zaplatit do šedesáti dnů.",
        },
      ],
    });

    expect(result.skipped).toEqual([]);
    const marksByText: Record<string, string[]> = {};
    view.state.doc.descendants((node) => {
      if (!node.isText) {
        return;
      }
      marksByText[node.text ?? ""] = node.marks.map((mark) => mark.type.name);
    });
    expect(marksByText["třiceti"]).toContain("deletion");
    expect(marksByText["šedesáti"]).toContain("insertion");
    expect(marksByText["Kupující musí zaplatit do "] ?? []).not.toContain(
      "deletion",
    );
  });
});
