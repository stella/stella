import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad bridges in both assertion syntaxes", async () => {
  expect(
    await lintSingleRule(
      "no-unjustified-double-assertion",
      "const a = value as unknown as Widget;\nconst b = value as object as Widget;\nconst c = value as Record<string, unknown> as Widget;\nconst d = value as Readonly<Record<PropertyKey, object>> as Widget;\nconst e = <Widget><unknown>value;",
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts adjacent runtime rationale and canonical rationale references", async () => {
  expect(
    await lintSingleRule(
      "no-unjustified-double-assertion",
      "// SAFETY: the parser validates the domain fields before returning.\nconst a = value as unknown as Widget;\n// See SAFETY comment on the validated parser above.\nconst b = value as object as Widget;",
    ),
  ).toEqual([]);
});

test("does not reuse rationale across an intervening statement or trailing comment", async () => {
  expect(
    await lintSingleRule(
      "no-unjustified-double-assertion",
      "// SAFETY: this invariant applies to the next statement.\nconst prior = value as Widget;\nconst a = value as unknown as Widget;\nconst unrelated = value; // SAFETY: documents only this statement.\nconst b = value as unknown as Widget;",
    ),
  ).toEqual([3, 5]);
});

test("accepts single assertions and structurally narrow intermediate types", async () => {
  expect(
    await lintSingleRule(
      "no-unjustified-double-assertion",
      "const a = value as Widget;\nconst b = value as { id: string } as Widget;",
    ),
  ).toEqual([]);
});
