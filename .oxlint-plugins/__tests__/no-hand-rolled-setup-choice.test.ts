import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-hand-rolled-setup-choice";

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "setup-screen.tsx" });

describe.serial(RULE_NAME, () => {
  test("reports radios, radio groups and choice labels drawn by hand", async () => {
    const source = [
      `export const _a = () => <input name="n" type="radio" value="a" />;`,
      `export const _b = () => <div aria-label="Choice" role="radiogroup" />;`,
      `export const _c = () => <span role={"radio"} />;`,
      `export const _d = () => <Label htmlFor="a" variant="choice-card">A</Label>;`,
      `export const _e = () => <Label htmlFor="a" variant={"choice"}>A</Label>;`,
      `export const _f = () => <input type={"radio"} />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("accepts the shared parts, other controls and lookalike attributes", async () => {
    const source = [
      `export const _a = () => <ChoiceGroup label="Choice">cards</ChoiceGroup>;`,
      `export const _b = () => <ChoiceCard checked title="A" value="a" />;`,
      `export const _c = () => <input type="checkbox" />;`,
      `export const _d = () => <Button type="radio" />;`,
      `export const _e = () => <Badge variant="choice" />;`,
      `export const _f = () => <div role="group" />;`,
      `export const _g = () => <input type={kind} />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
