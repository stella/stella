import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports direct ambient time and entropy execution", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      'Date.now();\nDate("fixed");\nnew Date();\nTemporal.Now.instant();\nMath.random();\ncrypto.randomUUID();\ncrypto.getRandomValues(bytes);\nBun.randomUUIDv7();\nperformance.now();\nglobalThis.Date.now();',
      {},
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("follows Node imports and nested webcrypto destructuring", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      'import { randomBytes as bytes, webcrypto } from "node:crypto";\nimport * as cryptoModule from "crypto";\nconst { randomUUID: uuid } = webcrypto;\nbytes(4);\nuuid();\ncryptoModule.randomInt(10);',
      {},
    ),
  ).toEqual([4, 5, 6]);
});

test("resolves immutable aliases and object spread execution", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      "const now = Date.now;\nconst { random: entropy } = Math;\nconst bag = { now, entropy };\nconst copy = { ...bag };\ncopy.now();\ncopy.entropy();",
      {},
    ),
  ).toEqual([5, 6]);
});

test("recognizes execution by proven built in callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      "[1].map(Date.now);\nPromise.resolve(1).then(Math.random);\nsetTimeout(Date.now, 10);",
      {},
    ),
  ).toEqual([1, 2, 3]);
});

test("recognizes explicit call apply and Reflect invocation", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      "Date.now.call(null);\nMath.random.apply(null, []);\nReflect.apply(Date.now, null, []);",
      {},
    ),
  ).toEqual([1, 2, 3]);
});

test("allows explicit dates mutable aliases and lexical shadows", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      'new Date(0);\nnew Date("2020-01-01");\nlet now = Date.now; now();\nfunction local(Date, Math, crypto, Bun, performance) { Date.now(); Math.random(); crypto.randomUUID(); Bun.randomUUIDv7(); performance.now(); }',
      {},
    ),
  ).toEqual([]);
});

test("allows storing references and unknown callback receivers", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      "const policy = { now: Date.now, entropy: Math.random };\nunknownCollection.map(Date.now);",
      {},
    ),
  ).toEqual([]);
});

test("terminates cyclic aliases without inventing ambient provenance", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-nondeterminism",
      "const first = second;\nconst second = first;\nfirst();",
      {},
    ),
  ).toEqual([]);
});
