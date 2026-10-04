import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(
    "no-computed-key-record-assignment",
    [...lines, ""].join("\n"),
  );

describe.serial("no-computed-key-record-assignment", () => {
  test("reports a record rebuilt by computed-key assignment", async () => {
    expect(
      await lint([
        "declare const input: Record<string, unknown>;",
        "export const copy = () => {",
        "  const out: Record<string, unknown> = {};",
        "  for (const [key, value] of Object.entries(input)) {",
        "    out[key] = value;",
        "  }",
        "  return out;",
        "};",
      ]),
    ).toEqual([5]);
  });

  test("reports every assignment operator and wrapped initializers", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const counts = {} as Record<string, number>;",
        "const groups = {} satisfies Record<string, string[]>;",
        "let seeded = { a: 1 };",
        "counts[key] = (counts[key] ?? 0) + 1;",
        "counts[key] += 1;",
        "(groups[key] ??= []).push(key);",
        "seeded[key] ||= 2;",
      ]),
    ).toEqual([5, 6, 7, 8]);
  });

  test("reports a module-level record written from a function", async () => {
    expect(
      await lint([
        "const cache: Record<string, number> = {};",
        "export const remember = (key: string) => {",
        "  cache[key] = 1;",
        "};",
      ]),
    ).toEqual([3]);
  });

  test("accepts static keys, other receivers, and own-property builders", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "declare const input: Record<string, unknown>;",
        "declare const make: () => Record<string, unknown>;",
        "export const accepted = (param: Record<string, unknown>) => {",
        "  const fixed: Record<string, unknown> = {};",
        '  fixed["status"] = 1;',
        "  fixed[0] = 1;",
        "  fixed[`literal`] = 1;",
        "  param[key] = 1;",
        "  const made = make();",
        "  made[key] = 1;",
        "  const list: unknown[] = [];",
        "  list[list.length] = 1;",
        "  const map = new Map<string, unknown>([[key, 1]]);",
        "  return [fixed, made, list, map, Object.fromEntries(Object.entries(input))];",
        "};",
      ]),
    ).toEqual([]);
  });

  test("resolves the receiver by scope, not by name", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const out: Record<string, unknown> = {};",
        "export const shadowed = (out: Record<string, unknown>) => {",
        "  out[key] = 1;",
        "};",
        "export const reported = () => {",
        "  out[key] = 1;",
        "};",
      ]),
    ).toEqual([7]);
  });
});
