import { expect, test } from "bun:test";

import { headMatterPrecedesBody } from "@stll/legal-ast/document-ast";

import {
  buildValidateAstFixtures,
  buildValidateAstInputs,
} from "@/api/tests/helpers/validate-ast-inputs";

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

test("stored source fixtures keep head matter before the decision body", async () => {
  const fixtures = await buildValidateAstFixtures();
  expect(fixtures.length).toBeGreaterThan(0);
  for (const fixture of fixtures) {
    expect(headMatterPrecedesBody(fixture.parse().blocks), fixture.name).toBe(
      true,
    );
  }
});
