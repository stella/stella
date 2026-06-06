import { describe, expect, test } from "bun:test";

import { isStatuteAst, parseStatuteAst } from "./statute-ast";
import type { StatuteAst } from "./statute-ast";

const statuteAst = {
  version: 1,
  source: {
    system: "sk-slovlex",
    eliExpressionUri: "eli/sk/zz/2005/300/2026-01-01",
    sourceUrl: "https://example.test/statute",
  },
  metadata: {
    naturalId: "300/2005",
    title: "Criminal Code",
    language: "sk",
    status: "consolidated",
    validFrom: "2026-01-01",
    validTo: null,
  },
  body: [
    {
      type: "provision",
      eId: "par_1",
      wId: "par_1",
      anchorId: "par-1",
      kind: "paragraph",
      num: "§ 1",
      heading: [{ type: "text", text: "Purpose" }],
      plainText: "Purpose",
      children: [
        {
          type: "paragraph",
          eId: "par_1__ods_1",
          anchorId: "par-1-ods-1",
          inlines: [{ type: "text", text: "Text." }],
          plainText: "Text.",
        },
      ],
    },
  ],
} satisfies StatuteAst;

describe("statute AST", () => {
  test("validates the persisted v1 statute shape", () => {
    expect(isStatuteAst(statuteAst)).toBe(true);
    expect(parseStatuteAst(JSON.stringify(statuteAst))).toEqual(statuteAst);
  });

  test("rejects unknown statuses", () => {
    const invalid = {
      ...statuteAst,
      metadata: { ...statuteAst.metadata, status: "draft" },
    };

    expect(isStatuteAst(invalid)).toBe(false);
  });
});
