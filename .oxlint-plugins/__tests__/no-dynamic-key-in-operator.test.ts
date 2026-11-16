import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-dynamic-key-in-operator";
const lint = async (source: string) => await lintSingleRule(RULE_NAME, source);

describe.serial(RULE_NAME, () => {
  test("reports membership by a key the code does not spell out", async () => {
    const source = [
      "const TABLE = { text: true } as const;",
      "export const one = (type: string) => type in TABLE;",
      "export const two = (part: { name: string }) => part.name in TABLE;",
      "export const three = (key: string, input: object) => !(key in input);",
      "export const four = (index: number, seen: object) => index in seen;",
      // An interpolated key is as dynamic as the key itself.
      ["export const five = (key: string) => `$", "{key}` in TABLE;"].join(""),
    ].join("\n");
    expect(await lint(source)).toEqual([2, 3, 4, 5, 6]);
  });

  test("accepts literal property checks and private brand checks", async () => {
    const source = [
      "export const one = (part: object) => 'name' in part;",
      "export const two = (part: object) => 0 in part;",
      "export class Brand { #id = 1; static is(value: object) { return #id in value; } }",
      "export const three = (part: object) => `type` in part;",
    ].join("\n");
    expect(await lint(source)).toEqual([]);
  });
});
