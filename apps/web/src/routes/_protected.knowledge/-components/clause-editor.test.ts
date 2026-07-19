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
  canReviewFlushReportResolved,
  type ClauseEditorReviewStatus,
  hasAlignedClauseStructure,
  isRewriteStale,
  isStaleSaveSettlement,
  nextRetryPendingToken,
  nonHistoricalDispatch,
  resolveRewriteBaseline,
  reviewFlushTokenForSave,
  reviewResolutionStatus,
  settleReviewPersist,
  shouldKeepBodyPanelMounted,
  shouldReissueAfterStaleSettlement,
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

describe("rewrite baseline sourced from live editor content", () => {
  // Regression: the AI-rewrite baseline used to come from the `content`
  // prop (server/query state), which lags behind an unsaved edit sitting in
  // the editor during the debounced-autosave window. Building the rewrite
  // (and the tracked-change diff) against that stale prop, then applying
  // the accept, silently discarded the user's unsaved edit.

  test("a fresh prompt sources the baseline from the live body, not a separately-tracked value", () => {
    const liveBody: ClauseParagraph[] = [{ text: "Live unsaved edit." }];
    expect(resolveRewriteBaseline({ status: "prompting" }, liveBody)).toBe(
      liveBody,
    );
  });

  test("a regenerate reuses the open review's own baseline, not the live (tracked-change) doc", () => {
    const reviewBaseline: ClauseParagraph[] = [{ text: "Pre-review text." }];
    const liveTrackedDoc: ClauseParagraph[] = [
      { text: "Pre-review text. AI insert." },
    ];
    expect(
      resolveRewriteBaseline(
        { status: "reviewing", baseline: reviewBaseline },
        liveTrackedDoc,
      ),
    ).toBe(reviewBaseline);
  });

  test("isRewriteStale is false while the live doc still matches the captured baseline", () => {
    const baseline: ClauseParagraph[] = [{ text: "Baseline text." }];
    const stillMatching: ClauseParagraph[] = [{ text: "Baseline text." }];
    expect(isRewriteStale(stillMatching, baseline)).toBe(false);
  });

  test("isRewriteStale fires when the live doc changes during generation — the content-changed abort path", () => {
    const baseline: ClauseParagraph[] = [{ text: "Baseline text." }];
    const changedDuringGeneration: ClauseParagraph[] = [
      { text: "Changed mid-generation." },
    ];
    expect(isRewriteStale(changedDuringGeneration, baseline)).toBe(true);
  });

  test("a rewrite built from the live (unsaved) body diffs against that body, not a stale server body", () => {
    // The editor holds an unsaved edit that hasn't reached the server yet —
    // `detail.body` (the stale server prop) still has the original text.
    const staleServerBody: ClauseParagraph[] = [
      { text: "Buyer must pay within 30 days." },
    ];
    const liveUnsavedBody: ClauseParagraph[] = [
      { text: "Seller must pay on delivery." },
    ];
    const aiRewritten: ClauseParagraph[] = [
      { text: "Seller must pay within 10 days of delivery." },
    ];

    const baseline = resolveRewriteBaseline(
      { status: "prompting" },
      liveUnsavedBody,
    );
    expect(baseline).toEqual(liveUnsavedBody);
    expect(baseline).not.toEqual(staleServerBody);

    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, aiRewritten);
    expect(revisionIds).toHaveLength(1);

    // Rejecting the AI's hunk must restore the user's unsaved edit exactly —
    // not the stale server body. Had the baseline wrongly been
    // `staleServerBody`, accepting the suggestion would have replaced the
    // editor's live content with a doc diffed against text the user had
    // already changed away from: the unsaved edit would be gone the moment
    // the suggestion applied, with no tracked-change hunk left to reject it
    // back.
    const rejectedState = applyTrackedCommand(
      doc,
      rejectAIEditRevision(revisionIds),
    );
    expect(tipTapToClauseBody(rejectedState.doc.toJSON())).toEqual(
      liveUnsavedBody,
    );
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

describe("canReviewFlushReportResolved", () => {
  // Regression for `ClauseBodyEditor.saveBody`'s unconditional
  // `onReviewStatusChange("resolved")` on any successful persist (bug
  // introduced when that emission moved into `saveBody`): a plain
  // debounced/blur autosave that started *before* a review begins can
  // settle *after* the editor already reports "pending"/"persisting", and
  // used to clear the review gate through that same success path even
  // though it has nothing to do with the review. `saveBody` now only
  // touches the gate for the save carrying the current review-flush epoch
  // token, minted once, inside `onReviewResolved`.

  test("(a) a stale autosave carries no token, so it never reports resolved, no matter the current epoch", () => {
    expect(canReviewFlushReportResolved(undefined, 0)).toBe(false);
    expect(canReviewFlushReportResolved(undefined, 3)).toBe(false);
  });

  test("(b) the review's own flush — token matching the current epoch — reports resolved", () => {
    expect(canReviewFlushReportResolved(1, 1)).toBe(true);
  });

  test("a review flush superseded by a second review resolving before the first's persist settles no longer reports resolved — only the newest flush wins", () => {
    // First review resolves: mint token 1 and start its persist.
    const firstFlushToken = 1;
    // A second review resolves before the first's persist settles: mint
    // token 2. The epoch the caller compares against has moved on.
    const currentEpoch = 2;

    expect(canReviewFlushReportResolved(firstFlushToken, currentEpoch)).toBe(
      false,
    );
    expect(canReviewFlushReportResolved(2, currentEpoch)).toBe(true);
  });

  // End-to-end simulation of the full race using the same call shape as
  // `ClauseBodyEditor.saveBody`: a settling save only flips a caller-side
  // `reported` flag when it's allowed to.
  test("a pre-review autosave settling mid-review leaves the gate untouched, and the review's own flush still resolves it correctly", async () => {
    let reviewFlushEpoch = 0;
    // A plain `let` here gets narrowed by control-flow analysis to the
    // literal it was last assigned in *this* scope ("pending"), even though
    // `settleSave` below can reassign it to "resolved" — TS doesn't widen a
    // captured variable's flow type back out just because a closure that
    // mutates it exists. Route the mutation through an object property
    // instead: TS doesn't narrow properties the same way, so both `expect`s
    // below see the full `ClauseEditorReviewStatus` union, matching runtime
    // reality.
    const state: { reported: ClauseEditorReviewStatus } = {
      reported: "pending",
    };

    const settleSave = (reviewFlushToken: number | undefined) => {
      if (canReviewFlushReportResolved(reviewFlushToken, reviewFlushEpoch)) {
        state.reported = "resolved";
      }
    };

    // A blur/debounced autosave kicked off before the review began finally
    // settles now, while the review is still "pending" — it carries no
    // token.
    settleSave(undefined);
    expect(state.reported).toBe("pending");

    // The review resolves: `onReviewResolved` mints the epoch's token and
    // its own flush settles successfully.
    const reviewFlushToken = (reviewFlushEpoch += 1);
    settleSave(reviewFlushToken);
    expect(state.reported).toBe("resolved");
  });
});

describe("retry-pending gate self-healing (nextRetryPendingToken / reviewFlushTokenForSave)", () => {
  // Regression for the fix above: gating `saveBody`'s success path on a
  // token that only the review's own flush ever carried also broke the
  // failure path's documented contract ("a later successful persist through
  // this same function ... lifts it"). A failed flush left `persisting`,
  // but the only retries a user could trigger afterward were plain
  // blur/debounce autosaves, which never carry a token — so the gate could
  // never resolve again. `nextRetryPendingToken` arms a retry on a
  // qualifying failure; `reviewFlushTokenForSave` lets the *next* saveBody
  // call — any trigger — pick that token up.
  //
  // Full machine under test: pending -> persisting -> (success -> resolved
  // | failure -> persisting+retryPending -> any later successful save ->
  // resolved). The original stale-pre-review-autosave race must stay inert
  // throughout.

  // A minimal simulation of ClauseBodyEditor's saveBody, using plain
  // variables in place of the component's refs/state.
  const makeHarness = () => {
    let reviewFlushEpoch = 0;
    let retryPendingToken: number | undefined;
    let reported: ClauseEditorReviewStatus = "pending";

    const saveBody = (
      explicitToken: number | undefined,
      outcome: "success" | "failure",
    ) => {
      const reviewFlushToken = reviewFlushTokenForSave(
        explicitToken,
        retryPendingToken,
      );
      retryPendingToken = undefined;

      if (outcome === "failure") {
        retryPendingToken = nextRetryPendingToken(
          reviewFlushToken,
          reviewFlushEpoch,
        );
        return;
      }

      if (canReviewFlushReportResolved(reviewFlushToken, reviewFlushEpoch)) {
        reported = "resolved";
      }
    };

    const mintReviewFlush = () => (reviewFlushEpoch += 1);

    return {
      saveBody,
      mintReviewFlush,
      getReported: () => reported,
      setReported: (status: ClauseEditorReviewStatus) => {
        reported = status;
      },
      getRetryPendingToken: () => retryPendingToken,
    };
  };

  test("the exact stick case: a failed review flush followed by a tokenless retry save still resolves", () => {
    const h = makeHarness();
    h.setReported("persisting");

    // The review resolves; onReviewResolved mints a token and flushes — the
    // save fails (e.g. a transient network error).
    const flushToken = h.mintReviewFlush();
    h.saveBody(flushToken, "failure");
    expect(h.getReported()).toBe("persisting");
    expect(h.getRetryPendingToken()).toBe(flushToken);

    // Before this fix, every subsequent retry is a plain blur/debounce
    // autosave carrying no token, so the gate stuck forever. Now the next
    // save — however it's triggered — picks up the armed retry token.
    h.saveBody(undefined, "success");
    expect(h.getReported()).toBe("resolved");
  });

  test("repeated failures keep re-arming the retry (self-healing survives more than one failed retry)", () => {
    const h = makeHarness();
    h.setReported("persisting");

    const flushToken = h.mintReviewFlush();
    h.saveBody(flushToken, "failure");
    expect(h.getRetryPendingToken()).toBe(flushToken);

    // The picked-up retry itself fails too.
    h.saveBody(undefined, "failure");
    expect(h.getReported()).toBe("persisting");
    expect(h.getRetryPendingToken()).toBe(flushToken);

    // A third save, still tokenless, finally succeeds.
    h.saveBody(undefined, "success");
    expect(h.getReported()).toBe("resolved");
  });

  test("a plain autosave failing with no review in flight does not arm a retry", () => {
    const h = makeHarness();
    h.setReported("resolved");

    // No review ever resolved (epoch stays 0, no token was ever minted): an
    // ordinary autosave failing here has no gate to unblock.
    h.saveBody(undefined, "failure");
    expect(h.getRetryPendingToken()).toBeUndefined();
    expect(h.getReported()).toBe("resolved");
  });

  test("a stale pre-review autosave settling after a retry was armed still cannot resolve the gate", () => {
    const h = makeHarness();
    h.setReported("pending");

    // A blur/debounce autosave starts before any review — it captures its
    // token (none) now, even though it doesn't "settle" (call saveBody's
    // continuation) until later.
    const staleToken = reviewFlushTokenForSave(undefined, undefined);

    // The review begins and resolves; its flush fails and arms a retry.
    const flushToken = h.mintReviewFlush();
    h.setReported("persisting");
    h.saveBody(flushToken, "failure");
    expect(h.getRetryPendingToken()).toBe(flushToken);

    // The stale autosave finally settles. It never re-reads
    // `retryPendingToken` (its token was captured before the retry was
    // armed), so it must not consume it or resolve the gate.
    if (
      canReviewFlushReportResolved(
        staleToken,
        /* epoch at the time saveBody's success path runs */ 1,
      )
    ) {
      h.setReported("resolved");
    }
    expect(h.getReported()).toBe("persisting");
    // The armed retry token is untouched, still available for a real retry.
    expect(h.getRetryPendingToken()).toBe(flushToken);
  });

  test("a retry token from a superseded review can't clear a newer review's gate; the newer flush's own token wins", () => {
    const h = makeHarness();
    h.setReported("persisting");

    // First review resolves and its flush fails, arming a retry for epoch 1.
    const firstFlushToken = h.mintReviewFlush();
    h.saveBody(firstFlushToken, "failure");
    expect(h.getRetryPendingToken()).toBe(firstFlushToken);

    // Before any autosave picks that up, a second review resolves — a fresh
    // epoch token is minted and flushed explicitly (superseding the first).
    const secondFlushToken = h.mintReviewFlush();
    h.saveBody(secondFlushToken, "success");

    expect(secondFlushToken).not.toBe(firstFlushToken);
    expect(h.getReported()).toBe("resolved");
    // The stale first-epoch retry token was discarded as a side effect of
    // the second flush's explicit token taking priority.
    expect(h.getRetryPendingToken()).toBeUndefined();
  });

  describe("nextRetryPendingToken", () => {
    test("arms with the current epoch only when the failing save was itself allowed to resolve", () => {
      expect(nextRetryPendingToken(1, 1)).toBe(1);
      expect(nextRetryPendingToken(undefined, 1)).toBeUndefined();
      expect(nextRetryPendingToken(1, 2)).toBeUndefined();
    });
  });

  describe("reviewFlushTokenForSave", () => {
    test("prefers the explicit token over a pending retry token", () => {
      expect(reviewFlushTokenForSave(2, 1)).toBe(2);
    });

    test("falls back to the pending retry token when there is no explicit token", () => {
      expect(reviewFlushTokenForSave(undefined, 1)).toBe(1);
    });

    test("is undefined when neither is set (an ordinary autosave with nothing pending)", () => {
      expect(reviewFlushTokenForSave(undefined, undefined)).toBeUndefined();
    });
  });
});

describe("shouldKeepBodyPanelMounted", () => {
  // Regression for switching Body → Variants/History mid-review: Base UI's
  // `Tabs.Panel` unmounts hidden panels by default, destroying the
  // `ClauseEditor` (and its in-memory tracked-change state) while the
  // review outcome was still unknown — stranding the gate with no review UI
  // left to resolve it. "pending" has a live, interactive review UI (the AI
  // edit bar / hunk menu) that a tab switch could destroy. "persisting" has
  // none, but its save outcome is still unknown: on a failed save, the
  // accepted body needed to retry exists only in that `ClauseEditor`
  // instance, so unmounting it is unrecoverable client-side. Only
  // "resolved" is safe to unmount.

  test("pins the panel mounted while a review is pending", () => {
    expect(shouldKeepBodyPanelMounted("pending")).toBe(true);
  });

  test("pins the panel mounted while persisting (save outcome not yet known)", () => {
    expect(shouldKeepBodyPanelMounted("persisting")).toBe(true);
  });

  test("does not pin the panel outside a review", () => {
    expect(shouldKeepBodyPanelMounted("resolved")).toBe(false);
  });
});

describe("isStaleSaveSettlement / shouldReissueAfterStaleSettlement", () => {
  // Regression for the write-side counterpart of the epoch/token race above:
  // a body autosave that started *before* an AI review is accepted can
  // still be in flight when the review's own flush persists the accepted
  // body. `saveBody` aborts the older request when the newer one starts,
  // but abort can't recall a write that had already reached the server —
  // these two functions are the guard that holds regardless of how that
  // network race resolves.

  test("nothing has settled yet: never stale", () => {
    expect(isStaleSaveSettlement(1, undefined)).toBe(false);
  });

  test("this settlement is the newest so far: not stale", () => {
    expect(isStaleSaveSettlement(2, 1)).toBe(false);
  });

  test("a strictly newer save already settled: stale", () => {
    expect(isStaleSaveSettlement(1, 2)).toBe(true);
  });

  test("reissue only when the stale request actually reached the server (settled successfully)", () => {
    expect(shouldReissueAfterStaleSettlement(true, true)).toBe(true);
    expect(shouldReissueAfterStaleSettlement(true, false)).toBe(false);
    expect(shouldReissueAfterStaleSettlement(false, true)).toBe(false);
    expect(shouldReissueAfterStaleSettlement(false, false)).toBe(false);
  });
});

describe("write-ordering matrix: saveBody vs. a stale in-flight save", () => {
  // End-to-end simulation of `ClauseBodyEditor.saveBody`'s write-ordering
  // guard, using the same call shape as the real function: each `startSave`
  // mints a sequence, aborts the previous in-flight controller (mirroring
  // `inFlightSaveAbortRef`), and returns a `settle` the test drives by hand
  // so settlement order — the actual load-bearing variable in this race —
  // is fully controllable rather than left to real network timing.

  type FakeResponse = { error?: { message: string } };

  const makeSaveHarness = () => {
    let sequenceCounter = 0;
    let inFlightAbort: AbortController | null = null;
    let latestSettled: { sequence: number; body: string } | undefined;
    const toasts: string[] = [];
    const gateReports: string[] = [];
    const reissuedBodies: string[] = [];

    const startSave = (body: string) => {
      const sequence = (sequenceCounter += 1);
      inFlightAbort?.abort();
      const controller = new AbortController();
      inFlightAbort = controller;

      const settle = (response: FakeResponse) => {
        const isStale = isStaleSaveSettlement(
          sequence,
          latestSettled?.sequence,
        );

        if (controller.signal.aborted || isStale) {
          // Superseded: no toast, no gate report — matching `saveBody`'s
          // early return before either side effect.
          if (
            shouldReissueAfterStaleSettlement(isStale, !response.error) &&
            latestSettled
          ) {
            reissuedBodies.push(latestSettled.body);
          }
          return;
        }

        if (response.error) {
          toasts.push(response.error.message);
          return;
        }

        latestSettled = { sequence, body };
        gateReports.push(body);
      };

      return { sequence, controller, settle };
    };

    return {
      startSave,
      toasts,
      gateReports,
      reissuedBodies,
      getLatestSettled: () => latestSettled,
    };
  };

  test("the reported P1 race: a pre-review autosave still in flight at accept time, settling after the accepted flush, is discarded and the accepted body is re-persisted", () => {
    const h = makeSaveHarness();

    // A debounced autosave starts first, carrying the pre-AI body.
    const stale = h.startSave("pre-AI body");
    expect(stale.controller.signal.aborted).toBe(false);

    // The AI review is accepted while that autosave is still in flight:
    // `onReviewResolved` flushes the accepted body — starting this new save
    // aborts the still-pending autosave's controller.
    const accepted = h.startSave("accepted AI body");
    expect(stale.controller.signal.aborted).toBe(true);

    // The accepted-body flush reaches the server and settles first (this is
    // exactly what the review comment describes: the review's own flush
    // completes while the older autosave is still outstanding).
    accepted.settle({});
    expect(h.gateReports).toEqual(["accepted AI body"]);

    // The stale autosave's request had already reached the server before
    // the local `abort()` could cut it off, so it still comes back with a
    // "successful" response once it finally settles.
    stale.settle({});

    // It must not be treated as the current save: no error toast, no gate
    // report for the stale body — and because its write did land (proven by
    // settling without an error) after the accepted body's own write, the
    // accepted body gets defensively re-persisted once.
    expect(h.toasts).toEqual([]);
    expect(h.gateReports).toEqual(["accepted AI body"]);
    expect(h.reissuedBodies).toEqual(["accepted AI body"]);
  });

  test("abort surfaces no error toast even when the superseded request genuinely fails", () => {
    const h = makeSaveHarness();

    const first = h.startSave("draft 1");
    const second = h.startSave("draft 2");

    // The superseded request settles with a real network-level failure
    // (e.g. the connection was actually torn down before completing) —
    // still no toast, and nothing to repair since the write never landed.
    first.settle({ error: { message: "network aborted" } });
    expect(h.toasts).toEqual([]);
    expect(h.reissuedBodies).toEqual([]);

    second.settle({});
    expect(h.gateReports).toEqual(["draft 2"]);
  });

  test("normal sequential saves (no overlap) are unaffected — each reports as the current save", () => {
    const h = makeSaveHarness();

    const a = h.startSave("v1");
    a.settle({});
    expect(h.gateReports).toEqual(["v1"]);

    const b = h.startSave("v2");
    b.settle({});
    expect(h.gateReports).toEqual(["v1", "v2"]);
    expect(h.toasts).toEqual([]);
    expect(h.reissuedBodies).toEqual([]);
  });

  test("a genuine failure of the current (non-superseded) save still toasts normally", () => {
    const h = makeSaveHarness();

    const a = h.startSave("v1");
    a.settle({ error: { message: "server error" } });

    expect(h.toasts).toEqual(["server error"]);
    expect(h.gateReports).toEqual([]);
  });
});
