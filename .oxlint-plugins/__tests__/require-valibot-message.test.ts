import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "require-valibot-message";

test("rejects user-facing validators without a message", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `const email = v.email();
const minimum = v.minLength(2);
const pattern = v.regex(/x/);
const id = v.uuid();`,
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects undefined and blank messages", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `const email = v.email(undefined);
const blank = v.email("");
const spaces = v.minLength(2, "  ");
const template = v.maxLength(9, \`\`);`,
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts validators that receive a message", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `const email = v.email(t("auth.invalidEmail"));
const minimum = v.minLength(2, t("auth.tooShort"));
const pattern = v.regex(/x/, t("auth.invalidFormat"));`,
    ),
  ).toEqual([]);
});

test("ignores validators inside a fallback decoder", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `const page = v.fallback(v.pipe(v.number(), v.integer(), v.minValue(1)), 1);`,
    ),
  ).toEqual([]);
});
