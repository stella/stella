import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects absent, optional, nonstring and method message fields on tagged errors", async () => {
  expect(
    await lintSingleRule(
      "tagged-error-requires-message",
      [
        'class Missing extends TaggedError("Missing")<{ id: string }> {}',
        'class Optional extends TaggedError("Optional")<{ message?: string }> {}',
        'class NonString extends TaggedError("NonString")<{ message: unknown }> {}',
        'class Method extends TaggedError("Method")<{ message(): string }> {}',
        'const MissingExpression = class extends TaggedError("MissingExpression")<{ id: string }> {};',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("allows required string messages, named props and unrelated classes", async () => {
  expect(
    await lintSingleRule(
      "tagged-error-requires-message",
      [
        'class Good extends TaggedError("Good")<{ message: string }> {}',
        'const GoodExpression = class extends TaggedError("GoodExpression")<{ "message": string }> {};',
        "type Props = { message: string };",
        'class Named extends TaggedError("Named")<Props> {}',
        "class Ordinary extends Error {}",
      ].join("\n"),
    ),
  ).toEqual([]);
});
