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
