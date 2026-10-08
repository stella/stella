import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects unnamed throw assertions through synchronous and promise chains", async () => {
  expect(
    await lintSingleRule(
      "no-vacuous-throw-assertion",
      [
        "expect(() => parse(bad)).toThrow();",
        "expect(() => parse(bad)).toThrowError();",
        "expect(load()).rejects.toThrow();",
        "expect(load()).resolves.toThrowError();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("allows named errors, negated assertions and unrelated methods", async () => {
  expect(
    await lintSingleRule(
      "no-vacuous-throw-assertion",
      [
        'expect(() => parse(bad)).toThrow("invalid identifier");',
        "expect(() => parse(bad)).toThrow(/invalid/u);",
        "expect(load()).rejects.toThrow(TypeError);",
        "expect(() => parse(good)).not.toThrow();",
        "expect(load()).resolves.not.toThrowError();",
        "policy.toThrow();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
