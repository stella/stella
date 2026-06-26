import type { JSONContent } from "@tiptap/react";
import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Command } from "prosemirror-state";

import {
  acceptAIEditRevision,
  rejectAIEditRevision,
} from "@stll/folio-core/prosemirror/commands/comments";

import {
  buildTrackedChangeDoc,
  hasAlignedClauseStructure,
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
