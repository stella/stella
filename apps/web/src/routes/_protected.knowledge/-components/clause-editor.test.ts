import { describe, expect, test } from "bun:test";

import { CLAUSE_DIRECTIVE_NODE } from "./clause-directive-node";
import { clauseBodyToTipTap, tipTapToClauseBody } from "./clause-editor";
import type { ClauseParagraph } from "./clause-editor-types";

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
