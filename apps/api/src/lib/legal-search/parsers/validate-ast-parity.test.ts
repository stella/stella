import { expect, test } from "bun:test";

import { buildValidateAstInputs } from "@/api/tests/helpers/validate-ast-inputs";

import { validateAst } from "./validate-ast";
import verdicts from "./validate-ast-verdicts.golden.json";

test("stored case-law and deterministic malformed AST verdicts stay exact", async () => {
  const actual = [];
  for (const input of await buildValidateAstInputs()) {
    actual.push({
      name: input.name,
      result: validateAst(input.source, input.blocks),
    });
  }
  expect(JSON.stringify(actual)).toBe(JSON.stringify(verdicts));
});
