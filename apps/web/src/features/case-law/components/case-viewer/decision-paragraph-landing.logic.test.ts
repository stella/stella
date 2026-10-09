import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { decisionParagraphLanding } from "./decision-paragraph-landing.logic";

const ast = {
  version: 1,
  source: { system: "", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      type: "paragraph",
      id: "b-12",
      plainText: "First",
      anchorId: "p-12",
      number: 48,
      inlines: [{ type: "text", text: "First" }],
    },
    {
      type: "paragraph",
      id: "b-13",
      plainText: "Second",
      anchorId: "p-13",
      number: 49,
      inlines: [{ type: "text", text: "Second" }],
    },
    {
      type: "paragraph",
      id: "b-14",
      plainText: "Unnumbered",
      anchorId: "p-14",
      inlines: [{ type: "text", text: "Unnumbered" }],
    },
  ],
} satisfies DocumentAst;

describe("court paragraph landings", () => {
  test("uses court numbers rather than parser counters", () => {
    expect(decisionParagraphLanding(ast, "par=48-49")).toEqual({
      type: "range",
      range: { from: 48, to: 49 },
      anchorIds: ["p-12", "p-13"],
      firstAnchorId: "p-12",
    });
    expect(decisionParagraphLanding(ast, "#par=49")).toMatchObject({
      type: "range",
      anchorIds: ["p-13"],
    });
  });
  test.each([
    { fragment: "par=48-50", range: { from: 48, to: 50 } },
    { fragment: "par=12", range: { from: 12, to: 12 } },
  ])(
    "a valid missing range $fragment retains its court numbers for the notice",
    ({ fragment, range }) => {
      expect(decisionParagraphLanding(ast, fragment)).toEqual({
        type: "not-found",
        range,
      });
    },
  );
  test.each(["par=48a", "par=49-48", "par=1-501", "par=", "par=0"])(
    "invalid fragment %s does not become an anchor or missing range",
    (fragment) => {
      expect(decisionParagraphLanding(ast, fragment)).toEqual({
        type: "invalid",
      });
    },
  );
  test("a missing AST uses the existing unavailable state", () => {
    expect(decisionParagraphLanding(null, "par=48")).toEqual({
      type: "text-unavailable",
    });
  });
  test.each([undefined, "p-12", "h-1"])(
    "keeps ordinary anchor %s",
    (fragment) => {
      expect(decisionParagraphLanding(ast, fragment)).toEqual({
        type: "anchor",
        anchorId: fragment,
      });
    },
  );
});
