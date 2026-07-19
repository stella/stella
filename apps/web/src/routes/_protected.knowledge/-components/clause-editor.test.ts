import type { JSONContent } from "@tiptap/react";
import { describe, expect, test } from "bun:test";
import { closeHistory, history, undo, undoDepth } from "prosemirror-history";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Command } from "prosemirror-state";

import {
  acceptAIEditRevision,
  acceptAllChanges,
  rejectAIEditRevision,
} from "@stll/folio-core/prosemirror/commands/comments";

import {
  buildTrackedChangeDoc,
  hasAlignedClauseStructure,
  nonHistoricalDispatch,
  reviewResolutionStatus,
  settleReviewPersist,
  shouldKeepBodyPanelMounted,
} from "./clause-ai-tracked-changes";
import { CLAUSE_DIRECTIVE_NODE } from "./clause-directive-extension";
import { clauseBodyToTipTap, tipTapToClauseBody } from "./clause-editor-tiptap";
import type { ClauseParagraph } from "./clause-editor-types";

const trackedChangeSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
  marks: {
    bold: {},
    italic: {},
    insertion: {
      attrs: {
        revisionId: {},
        author: { default: "" },
        date: { default: null },
      },
    },
    deletion: {
      attrs: {
        revisionId: {},
        author: { default: "" },
        date: { default: null },
      },
    },
  },
});

const applyTrackedCommand = (
  doc: JSONContent,
  command: Command,
): EditorState => {
  const state = EditorState.create({
    schema: trackedChangeSchema,
    doc: trackedChangeSchema.nodeFromJSON(doc),
  });
  let nextState = state;
  const applied = command(state, (transaction) => {
    nextState = state.apply(transaction);
  });
  expect(applied).toBe(true);
  return nextState;
};

const trackedRuns = (
  node: JSONContent,
  out: { text: string; mark: string | null; revisionId: unknown }[] = [],
) => {
  if (node.type === "text" && typeof node.text === "string") {
    const mark = node.marks?.find(
      (candidate) =>
        candidate.type === "insertion" || candidate.type === "deletion",
    );
    out.push({
      text: node.text,
      mark: mark?.type ?? null,
      revisionId: mark?.attrs?.["revisionId"],
    });
  }
  for (const child of node.content ?? []) {
    trackedRuns(child, out);
  }
  return out;
};

const directive = (
  directiveKind: NonNullable<ClauseParagraph["directiveKind"]>,
  directiveExpression: string,
): ClauseParagraph => ({
  text: `{{#${directiveKind} ${directiveExpression}}}`.trim(),
  isDirective: true,
  directiveKind,
  directiveExpression,
});

describe("clause body ⇄ TipTap round-trip", () => {
  test("directives survive as atomic nodes at their position", () => {
    const body: ClauseParagraph[] = [
      directive("if", "is_company"),
      { text: "Company clause" },
      directive("else", ""),
      { text: "Individual clause" },
      directive("endif", ""),
    ];

    const doc = clauseBodyToTipTap(body);
    // Directives are real nodes, not stripped.
    expect(doc.content?.map((n) => n.type)).toEqual([
      CLAUSE_DIRECTIVE_NODE,
      "paragraph",
      CLAUSE_DIRECTIVE_NODE,
      "paragraph",
      CLAUSE_DIRECTIVE_NODE,
    ]);
    // And they round-trip back unchanged, in order.
    expect(tipTapToClauseBody(doc)).toEqual(body);
  });

  test("a directive carries its kind/expression/text on the node", () => {
    const doc = clauseBodyToTipTap([directive("each", "items")]);
    expect(doc.content?.at(0)).toEqual({
      type: CLAUSE_DIRECTIVE_NODE,
      attrs: { kind: "each", expression: "items", text: "{{#each items}}" },
    });
  });

  test("bold/italic runs and headings round-trip", () => {
    const body: ClauseParagraph[] = [
      { text: "Title", style: "heading", level: 2 },
      {
        text: "bold then plain",
        runs: [{ text: "bold", bold: true }, { text: " then plain" }],
      },
    ];
    expect(tipTapToClauseBody(clauseBodyToTipTap(body))).toEqual(body);
  });

  test("a flat bullet list round-trips as bulletList > listItem > paragraph", () => {
    const body: ClauseParagraph[] = [
      { text: "First", listKind: "bullet", listLevel: 0 },
      { text: "Second", listKind: "bullet", listLevel: 0 },
    ];

    const doc = clauseBodyToTipTap(body);
    expect(doc.content?.at(0)).toEqual({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First" }] },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Second" }] },
          ],
        },
      ],
    });
    expect(tipTapToClauseBody(doc)).toEqual(body);
  });

  test("an ordered list round-trips and keeps its kind", () => {
    const body: ClauseParagraph[] = [
      { text: "One", listKind: "ordered", listLevel: 0 },
      { text: "Two", listKind: "ordered", listLevel: 0 },
    ];

    const doc = clauseBodyToTipTap(body);
    expect(doc.content?.at(0)?.type).toBe("orderedList");
    expect(tipTapToClauseBody(doc)).toEqual(body);
  });

  test("nested list levels round-trip losslessly", () => {
    const body: ClauseParagraph[] = [
      { text: "Top", listKind: "bullet", listLevel: 0 },
      { text: "Child", listKind: "bullet", listLevel: 1 },
      { text: "Grandchild", listKind: "bullet", listLevel: 2 },
      { text: "Back to top", listKind: "bullet", listLevel: 0 },
    ];

    expect(tipTapToClauseBody(clauseBodyToTipTap(body))).toEqual(body);
  });

  test("a nested ordered list inside a bullet list round-trips", () => {
    const body: ClauseParagraph[] = [
      { text: "Bullet", listKind: "bullet", listLevel: 0 },
      { text: "Numbered child", listKind: "ordered", listLevel: 1 },
      { text: "Another bullet", listKind: "bullet", listLevel: 0 },
    ];

    expect(tipTapToClauseBody(clauseBodyToTipTap(body))).toEqual(body);
  });

  test("list items keep run formatting", () => {
    const body: ClauseParagraph[] = [
      {
        text: "bold item",
        runs: [{ text: "bold", bold: true }, { text: " item" }],
        listKind: "bullet",
        listLevel: 0,
      },
    ];

    expect(tipTapToClauseBody(clauseBodyToTipTap(body))).toEqual(body);
  });

  test("lists interleave with paragraphs and directives", () => {
    const body: ClauseParagraph[] = [
      { text: "Intro" },
      directive("if", "x"),
      { text: "Item A", listKind: "bullet", listLevel: 0 },
      { text: "Item B", listKind: "bullet", listLevel: 0 },
      directive("endif", ""),
      { text: "Outro" },
    ];

    expect(tipTapToClauseBody(clauseBodyToTipTap(body))).toEqual(body);
  });

  test("reordering reflects the editor's order — no stale-index resurrection", () => {
    // What the editor doc looks like after the author drags the directive
    // block below the paragraph: the converter must honor that order, not
    // restore the directive to where it originally sat.
    const reorderedDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Body first" }] },
        {
          type: CLAUSE_DIRECTIVE_NODE,
          attrs: { kind: "if", expression: "x", text: "{{#if x}}" },
        },
      ],
    };
    expect(tipTapToClauseBody(reorderedDoc)).toEqual([
      { text: "Body first" },
      directive("if", "x"),
    ]);
  });

  test("serialization keeps insertions and drops unresolved deletions", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "old wording",
              marks: [{ type: "deletion", attrs: { revisionId: 1 } }],
            },
            {
              type: "text",
              text: "new wording",
              marks: [{ type: "insertion", attrs: { revisionId: 1 } }],
            },
          ],
        },
      ],
    };

    expect(tipTapToClauseBody(doc)).toEqual([{ text: "new wording" }]);
  });
});

describe("buildTrackedChangeDoc", () => {
  test("rejecting restores the baseline and accepting keeps the rewrite", () => {
    const baseline = [{ text: "The seller pays." }];
    const revised = [{ text: "The buyer pays." }];

    const rejectedChange = buildTrackedChangeDoc(baseline, revised);
    const rejectedState = applyTrackedCommand(
      rejectedChange.doc,
      rejectAIEditRevision(rejectedChange.revisionIds),
    );
    expect(tipTapToClauseBody(rejectedState.doc.toJSON())).toEqual(baseline);

    const acceptedChange = buildTrackedChangeDoc(baseline, revised);
    const acceptedState = applyTrackedCommand(
      acceptedChange.doc,
      acceptAIEditRevision(acceptedChange.revisionIds),
    );
    expect(tipTapToClauseBody(acceptedState.doc.toJSON())).toEqual(revised);
  });

  test("rejecting preserves formatting across a changed run boundary", () => {
    const baseline: ClauseParagraph[] = [
      {
        text: "Bold old plain",
        runs: [
          { text: "Bold", bold: true },
          { text: " old", italic: true },
          { text: " plain" },
        ],
      },
    ];
    const revised = [{ text: "Bold new plain" }];

    const trackedChange = buildTrackedChangeDoc(baseline, revised);
    const rejectedState = applyTrackedCommand(
      trackedChange.doc,
      rejectAIEditRevision(trackedChange.revisionIds),
    );

    expect(tipTapToClauseBody(rejectedState.doc.toJSON())).toEqual(baseline);
  });

  test("structural alignment includes list and directive metadata", () => {
    expect(
      hasAlignedClauseStructure(
        [{ text: "Item", listKind: "bullet", listLevel: 0 }],
        [{ text: "Rewritten", listKind: "ordered", listLevel: 0 }],
      ),
    ).toBe(false);
    expect(
      hasAlignedClauseStructure(
        [directive("if", "company")],
        [directive("if", "person")],
      ),
    ).toBe(false);
  });

  test("only changed paragraphs carry tracked-change marks", () => {
    const baseline: ClauseParagraph[] = [
      { text: "The seller shall indemnify the buyer." },
      { text: "This stays the same." },
    ];
    const revised: ClauseParagraph[] = [
      { text: "Each party shall indemnify the other." },
      { text: "This stays the same." },
    ];

    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, revised);
    expect(revisionIds).toHaveLength(1);

    const runs = trackedRuns(doc);
    expect(
      runs.some((run) => run.text.includes("stays the same") && run.mark),
    ).toBe(false);
    expect(runs.some((run) => run.mark === "deletion")).toBe(true);
    expect(runs.some((run) => run.mark === "insertion")).toBe(true);
  });

  test("one paragraph edit shares one revision id", () => {
    const { doc, revisionIds } = buildTrackedChangeDoc(
      [{ text: "alpha beta gamma" }],
      [{ text: "alpha delta gamma" }],
    );

    expect(revisionIds).toHaveLength(1);
    const markedRevisionIds = new Set(
      trackedRuns(doc)
        .filter((run) => run.mark !== null)
        .map((run) => run.revisionId),
    );
    expect(markedRevisionIds.size).toBe(1);
  });

  test("directives stay unmarked without shifting paragraph alignment", () => {
    const baseline: ClauseParagraph[] = [
      directive("if", "x"),
      { text: "Original wording here." },
      directive("endif", ""),
    ];
    const revised: ClauseParagraph[] = [
      directive("if", "x"),
      { text: "Replaced wording here." },
      directive("endif", ""),
    ];

    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, revised);
    expect(revisionIds).toHaveLength(1);
    expect(
      doc.content?.filter((node) => node.type === CLAUSE_DIRECTIVE_NODE),
    ).toHaveLength(2);
    expect(trackedRuns(doc).some((run) => run.mark === "insertion")).toBe(true);
  });

  test("a changed list paragraph receives the tracked-change marks", () => {
    const baseline: ClauseParagraph[] = [
      { text: "Lead in." },
      { text: "first item", listKind: "bullet", listLevel: 0 },
      { text: "second item", listKind: "bullet", listLevel: 0 },
    ];
    const revised: ClauseParagraph[] = [
      { text: "Lead in." },
      { text: "first item", listKind: "bullet", listLevel: 0 },
      { text: "second item revised", listKind: "bullet", listLevel: 0 },
    ];

    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, revised);
    const runs = trackedRuns(doc);
    expect(revisionIds).toHaveLength(1);
    expect(
      runs.some(
        (run) => run.mark === "insertion" && run.text.includes("revised"),
      ),
    ).toBe(true);
    expect(
      runs.some((run) => run.mark !== null && run.text.includes("Lead in")),
    ).toBe(false);
  });
});

describe("undo history around AI review resolution", () => {
  test("resolving a review leaves nothing to undo — the resolved state persists", () => {
    const original: ClauseParagraph[] = [{ text: "Original sentence." }];
    const revisedByAi: ClauseParagraph[] = [{ text: "Revised sentence." }];

    let state = EditorState.create({
      schema: trackedChangeSchema,
      doc: trackedChangeSchema.nodeFromJSON(clauseBodyToTipTap(original)),
      plugins: [history()],
    });
    expect(undoDepth(state)).toBe(0);

    // Entering review replaces the whole doc with the tracked-change doc.
    // That transaction must be excluded from history (closeHistory forces
    // a fresh group so a real-world time gap — the in-flight AI request —
    // can't accidentally merge it with anything else).
    const { doc: trackedDoc, revisionIds } = buildTrackedChangeDoc(
      original,
      revisedByAi,
    );
    expect(revisionIds.length).toBeGreaterThan(0);
    state = state.apply(
      closeHistory(state.tr)
        .replaceWith(
          0,
          state.doc.content.size,
          trackedChangeSchema.nodeFromJSON(trackedDoc),
        )
        .setMeta("addToHistory", false),
    );
    expect(undoDepth(state)).toBe(0);

    // Resolve (accept all) through the same dispatch-wrapping helper the
    // editor's resolve commands use — also excluded from history.
    const beforeResolve = state;
    let resolved = state;
    const applied = acceptAllChanges()(
      beforeResolve,
      nonHistoricalDispatch((tr) => {
        resolved = beforeResolve.apply(closeHistory(tr));
      }),
    );
    expect(applied).toBe(true);
    state = resolved;
    expect(tipTapToClauseBody(state.doc.toJSON())).toEqual(revisedByAi);

    // The whole review round-trip (entering it and resolving it) left
    // nothing undoable: Cmd+Z right after resolving does nothing, so the
    // resolved state persists instead of restoring the tracked-change doc.
    expect(undoDepth(state)).toBe(0);
    const noopUndo = undo(state, () => {
      throw new Error("undo should not have found anything to dispatch");
    });
    expect(noopUndo).toBe(false);

    // A real edit made after resolving is a normal, historical event: it
    // undoes on its own, without resurrecting any tracked-change marks.
    const afterResolve = state;
    state = state.apply(
      state.tr.insertText(" User note.", state.doc.content.size - 1),
    );
    expect(tipTapToClauseBody(state.doc.toJSON())).toEqual([
      { text: "Revised sentence. User note." },
    ]);
    expect(undoDepth(state)).toBe(1);

    let undone = state;
    const undoApplied = undo(state, (tr) => {
      undone = state.apply(tr);
    });
    expect(undoApplied).toBe(true);
    expect(tipTapToClauseBody(undone.doc.toJSON())).toEqual(
      tipTapToClauseBody(afterResolve.doc.toJSON()),
    );
    expect(
      trackedRuns(undone.doc.toJSON()).every((run) => run.mark === null),
    ).toBe(true);
  });
});

describe("review resolution → persist gating", () => {
  // Regression for the race where `reviewStatus` flipped to "resolved" the
  // instant the final hunk resolved, while the accepted body's persist was
  // still in flight — a version save could fire in that window and snapshot
  // the stale pre-AI body. `reviewResolutionStatus` + `settleReviewPersist`
  // together keep the caller's reported status at "persisting" (which
  // version-save actions must treat identically to "pending") until the
  // persist settles — but only for callers that actually have an
  // incremental persist path (`onReviewResolved`); see below for the
  // no-handler case.

  test("a changed resolution reports 'persisting' when a persist handler exists — the caller must still gate on it", () => {
    expect(reviewResolutionStatus(true, true)).toBe("persisting");
  });

  test("an unchanged resolution (e.g. reject-all back to baseline) needs no persist, handler or not", () => {
    expect(reviewResolutionStatus(false, true)).toBe("resolved");
    expect(reviewResolutionStatus(false, false)).toBe("resolved");
  });

  // Regression for `ClauseFormDialog`: it has no `onReviewResolved` (the
  // form persists the body later, on submit), but the last round moved the
  // "resolved" emission into that handler's own persist call. With no
  // handler to ever call it, a changed resolution reported "persisting" and
  // nothing lifted it — the dialog's Save button stayed disabled forever.
  // Without a persist handler there is no async persist to gate on, so a
  // changed resolution must report "resolved" immediately.
  test("a changed resolution reports 'resolved' immediately when there is no persist handler", () => {
    expect(reviewResolutionStatus(true, false)).toBe("resolved");
  });

  // `settleReviewPersist` only runs `persist` and swallows an unexpected
  // exception; it never reports "resolved" itself. Reporting success is the
  // `persist` callback's own job (mirroring `ClauseBodyEditor.saveBody`,
  // which calls `onReviewStatusChange("resolved")` only once its POST
  // actually succeeds) — this is the load-bearing part of the fix: a naive
  // `.then(() => report("resolved"))` chained onto `settleReviewPersist`
  // would report success even when `persist` failed.

  test("accept-final-hunk: version save stays blocked until the persist resolves, then the persist's own success unblocks it", async () => {
    let resolvePersist: () => void = () => {
      throw new Error("resolvePersist called before assignment");
    };
    // Mirrors the real persist call: it reports "resolved" itself, from
    // inside the callback, only once it actually succeeds.
    const persist = async () =>
      new Promise<void>((resolve) => {
        resolvePersist = () => {
          reported = "resolved";
          resolve();
        };
      });

    // Mirrors the caller: report "persisting" synchronously on resolution...
    let reported: "resolved" | "persisting" = reviewResolutionStatus(
      true,
      true,
    );
    expect(reported).toBe("persisting");

    const settled = settleReviewPersist(persist);

    // ...and version-save actions (gated on reported !== "resolved") stay
    // blocked while the persist is still in flight.
    expect(reported).toBe("persisting");

    resolvePersist();
    await settled;

    expect(reported).toBe("resolved");
  });

  test("a persist failure leaves the gate blocked — settleReviewPersist does not report resolved on its own", async () => {
    const persist = async () => {
      throw new Error("save failed");
    };

    // The real persist call (saveBody) only touches `reported` on success;
    // a failure surfaces its own toast and never reaches that line, so
    // `reported` must stay at "persisting" even once `settleReviewPersist`
    // has swallowed the rejection and settled.
    const reported: "resolved" | "persisting" = reviewResolutionStatus(
      true,
      true,
    );
    await settleReviewPersist(persist);

    expect(reported).toBe("persisting");
  });

  test("no permanent wedge: a later successful retry through the same persist path lifts a gate stranded by an earlier failure", async () => {
    let reported: "resolved" | "persisting" = reviewResolutionStatus(
      true,
      true,
    );
    expect(reported).toBe("persisting");

    // First attempt fails (e.g. the initial accept-all flush) — the toast
    // fires elsewhere; the gate stays blocked.
    await settleReviewPersist(async () => {
      throw new Error("save failed");
    });
    expect(reported).toBe("persisting");

    // The user keeps editing; the body editor's normal debounced/blur
    // autosave retries the same persist call (same shape as saveBody) and
    // succeeds this time, reporting "resolved" itself.
    await settleReviewPersist(async () => {
      reported = "resolved";
    });
    expect(reported).toBe("resolved");
  });
});

describe("shouldKeepBodyPanelMounted", () => {
  // Regression for switching Body → Variants/History mid-review: Base UI's
  // `Tabs.Panel` unmounts hidden panels by default, destroying the
  // `ClauseEditor` (and its in-memory tracked-change state) while
  // `reviewStatus` was still "pending" — stranding the gate with no review
  // UI left to resolve it. Only "pending" has a live, interactive review UI
  // (the AI edit bar / hunk menu) that a tab switch could destroy;
  // "persisting" has none — its persist promise runs independently of
  // `ClauseEditor`'s lifecycle — so it doesn't need to be pinned.

  test("pins the panel mounted while a review is pending", () => {
    expect(shouldKeepBodyPanelMounted("pending")).toBe(true);
  });

  test("does not pin the panel once persisting (no interactive review UI left to lose)", () => {
    expect(shouldKeepBodyPanelMounted("persisting")).toBe(false);
  });

  test("does not pin the panel outside a review", () => {
    expect(shouldKeepBodyPanelMounted("resolved")).toBe(false);
  });
});
