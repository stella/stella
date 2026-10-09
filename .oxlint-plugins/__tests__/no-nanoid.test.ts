import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects every load of the removed package including types and subpaths", async () => {
  expect(
    await lintSingleRule(
      "no-nanoid",
      'import "nanoid";\nimport { nanoid as makeId } from "nanoid";\nimport type { nanoid } from "nanoid";\nconst module = require("nanoid/non-secure");\nconst pending = import("nanoid/async");\nexport * from "nanoid";',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows platform identifiers and unrelated package names", async () => {
  expect(
    await lintSingleRule(
      "no-nanoid",
      'import { randomUUID } from "node:crypto";\nconst id = Bun.randomUUIDv7();\nconst bytes = crypto.getRandomValues(new Uint8Array(8));\nimport "nanoid-like";',
    ),
  ).toEqual([]);
});
