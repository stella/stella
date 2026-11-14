import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { flattenInlineText } from "./inline.js";
import type { Inline } from "./inline.js";
import { parseStatuteAst } from "./statute-ast.js";
import type { StatuteAst, StatuteBlock } from "./statute-ast.js";

const localizedText = fc
  .array(
    fc.constantFrom(
      "zákon",
      "právo",
      "účinnosť",
      "číslo",
      "Z\u030cluty\u0301",
      " ",
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((parts) => parts.join(""));

const inlineRun = fc.array(
  fc.oneof(
    localizedText.map((text): Inline => ({ type: "text", text })),
    localizedText.map((text): Inline => ({
      type: "bold",
      children: [{ type: "text", text }],
    })),
    fc.constant<Inline>({ type: "line-break" }),
  ),
  { maxLength: 5 },
);

const makeParagraph = ([inlines, index]: [Inline[], number]): StatuteBlock => ({
  type: "paragraph",
  eId: `par_${String(index)}`,
  anchorId: `par-${String(index)}`,
  inlines,
  plainText: flattenInlineText(inlines),
});

const statute = fc
  .tuple(localizedText, fc.array(inlineRun, { maxLength: 12 }))
  .map(([title, runs]): StatuteAst => ({
    version: 1,
    source: {
      system: "property",
      eliExpressionUri: null,
      sourceUrl: "https://example.test/statute",
    },
    metadata: {
      naturalId: "1/2026",
      title,
      language: "cs-sk",
      status: "consolidated",
      validFrom: "2026-01-01",
      validTo: null,
    },
    body: runs.map((run, index) => makeParagraph([run, index])),
  }));

describe("statute AST properties", () => {
  test("JSON round-trips generated localized statute trees", () => {
    assertProperty(
      "JSON round-trips generated localized statute trees",
      fc.property(statute, (ast) => {
        expect(parseStatuteAst(JSON.stringify(ast))).toEqual(ast);
      }),
      { numRuns: 400 },
    );
  });

  test("rejects every generated duplicate identity", () => {
    assertProperty(
      "rejects every generated duplicate identity",
      fc.property(statute, inlineRun, (ast, inlines) => {
        const duplicate = {
          type: "paragraph",
          eId: "par_0",
          anchorId: "duplicate-anchor",
          inlines,
          plainText: flattenInlineText(inlines),
        } as const;
        const withExisting =
          ast.body.length === 0
            ? { ...ast, body: [duplicate, { ...duplicate, anchorId: "other" }] }
            : { ...ast, body: [...ast.body, duplicate] };
        expect(parseStatuteAst(withExisting)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
