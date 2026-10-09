import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects ambient, imported and aliased version four UUID generation", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        'import { randomUUID as makeId } from "node:crypto";',
        "makeId();",
        "crypto.randomUUID();",
        "globalThis.crypto.randomUUID();",
        'import * as nodeCrypto from "node:crypto";',
        "nodeCrypto.randomUUID();",
        'import defaultCrypto from "crypto";',
        "defaultCrypto.randomUUID();",
        'import { randomUUID } from "crypto";',
        "randomUUID();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 6, 8, 9, 10]);
});

test("allows ordered Bun identifiers and unrelated random UUID methods", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        "Bun.randomUUIDv7();",
        "crypto.getRandomValues(new Uint8Array(8));",
        'import { randomBytes } from "node:crypto";',
        "randomBytes(8);",
        'const local = { randomUUID: () => "local" };',
        "local.randomUUID();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
