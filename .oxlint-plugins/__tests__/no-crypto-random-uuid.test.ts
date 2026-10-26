import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects ambient crypto UUIDs and direct UUID package generators", async () => {
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
        'import { v4, v7 as makeV7, v5 } from "uuid";',
        "v4(); makeV7(); v5();",
        'import * as uuid from "uuid";',
        "uuid.v4(); uuid.v7(); uuid.validate(value);",
        'import uuidDefault from "uuid";',
        "uuidDefault.v7();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 6, 8, 9, 10, 11, 11, 14, 14, 16]);
});

test("rejects UUID methods through browser receivers, aliases, parameters and literal computed names", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        "const browserUuid = (browser: Pick<Window, 'crypto'>) => browser.crypto.randomUUID();",
        "const parameterUuid = (source: Crypto) => source.randomUUID();",
        "const alias = browser.crypto; alias.randomUUID();",
        "browser.crypto['randomUUID']();",
        "alias[`randomUUID`]();",
        "source?.randomUUID();",
        "source.randomUUID?.();",
        "const method = 'randomUUID'; source[method]();",
        "source.randomUUIDv7();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("allows ordered Bun identifiers and runtime UUID owners", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        "Bun.randomUUIDv7();",
        "crypto.getRandomValues(new Uint8Array(8));",
        'import { randomBytes } from "node:crypto";',
        "randomBytes(8);",
        'import { createRandomValue, createUuid } from "@/lib/uuid";',
        "createUuid(); createRandomValue();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
