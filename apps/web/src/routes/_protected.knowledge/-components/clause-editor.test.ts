import { describe, expect, test } from "bun:test";

import { CLAUSE_DIRECTIVE_NODE } from "./clause-directive-node";
import {
  buildTrackedChangeDoc,
  clauseBodyToTipTap,
  tipTapToClauseBody,
} from "./clause-editor";
import type { ClauseParagraph } from "./clause-editor-types";

/** Collect every text node in a doc with the tracked-change mark on it (if any). */
const trackedRuns = (
  node: {
    type?: string;
    text?: string;
    marks?: { type: string }[];
    content?: unknown[];
  },
  out: { text: string; mark: string | null }[] = [],
): { text: string; mark: string | null }[] => {
  if (node.type === "text" && typeof node.text === "string") {
    const mark = node.marks?.find(
      (m) => m.type === "insertion" || m.type === "deletion",
    );
    out.push({ text: node.text, mark: mark?.type ?? null });
  }
  for (const child of (node.content ?? []) as (typeof node)[]) {
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
});

describe("buildTrackedChangeDoc", () => {
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
    // The unchanged paragraph contributes only unmarked text.
    expect(runs.some((r) => r.text.includes("stays the same") && r.mark)).toBe(
      false,
    );
    // The changed paragraph contributes both a deletion and an insertion.
    expect(runs.some((r) => r.mark === "deletion")).toBe(true);
    expect(runs.some((r) => r.mark === "insertion")).toBe(true);
  });

  test("a paragraph's change shares one revisionId across its segments", () => {
    const { doc, revisionIds } = buildTrackedChangeDoc(
      [{ text: "alpha beta gamma" }],
      [{ text: "alpha delta gamma" }],
    );
    expect(revisionIds).toHaveLength(1);

    const findMarkedIds = (
      node: {
        type?: string;
        marks?: { type: string; attrs?: { revisionId?: number } }[];
        content?: unknown[];
      },
      ids = new Set<number>(),
    ): Set<number> => {
      for (const m of node.marks ?? []) {
        if (
          (m.type === "insertion" || m.type === "deletion") &&
          typeof m.attrs?.revisionId === "number"
        ) {
          ids.add(m.attrs.revisionId);
        }
      }
      for (const child of (node.content ?? []) as (typeof node)[]) {
        findMarkedIds(child, ids);
      }
      return ids;
    };
    // del + ins of one paragraph edit resolve as a single unit.
    expect(findMarkedIds(doc).size).toBe(1);
  });

  test("directives are never marked and don't shift the index alignment", () => {
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

    const directiveNodes =
      doc.content?.filter((n) => n.type === CLAUSE_DIRECTIVE_NODE) ?? [];
    expect(directiveNodes).toHaveLength(2);
    // The marked text lands on the paragraph between the directives, not on them.
    const runs = trackedRuns(doc);
    expect(runs.some((r) => r.mark === "insertion")).toBe(true);
  });

  test("a changed paragraph inside a list is marked (index maps through nesting)", () => {
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
    expect(revisionIds).toHaveLength(1);
    const runs = trackedRuns(doc);
    // "revised" was added inside the second list item.
    expect(
      runs.some((r) => r.mark === "insertion" && r.text.includes("revised")),
    ).toBe(true);
    expect(
      runs.some((r) => r.mark !== null && r.text.includes("Lead in")),
    ).toBe(false);
  });
});
