import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects direct and wrapped request offset schemas", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { offset: t.Integer() };",
        "const wrapped = { offset: t.Optional(t.Number()) };",
        "const number = { offset: t.Number() };",
        "const union = { offset: t.Union([t.Integer(), t.Number()]) };",
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/documents/list.ts" },
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("allows cursor request schemas and ordinary numeric offsets", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { cursor: t.Optional(t.String()), limit: t.Integer() };",
        "const position = { offset: 20 };",
        "const optionalPosition = { offset: computeOffset() };",
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/documents/list.ts" },
    ),
  ).toEqual([]);
});

test("allows the documented legacy skills endpoint", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { offset: t.Integer() };",
        "const wrapped = { offset: t.Optional(t.Number()) };",
        "const number = { offset: t.Number() };",
        "const union = { offset: t.Union([t.Integer(), t.Number()]) };",
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/skills/list.ts" },
    ),
  ).toEqual([]);
});

test("allows configured legacy endpoints without exempting other directories", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { offset: t.Integer() };",
        "const wrapped = { offset: t.Optional(t.Number()) };",
        "const number = { offset: t.Number() };",
        "const union = { offset: t.Union([t.Integer(), t.Number()]) };",
      ].join("\n"),
      {
        sourcePath: "apps/api/src/handlers/legacy/list.ts",
        ruleOptions: { allowedFiles: ["apps/api/src/handlers/legacy/list.ts"] },
      },
    ),
  ).toEqual([]);
});

test("keeps legacy endpoint basenames restricted in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { offset: t.Integer() };",
        "const wrapped = { offset: t.Optional(t.Number()) };",
        "const number = { offset: t.Number() };",
        "const union = { offset: t.Union([t.Integer(), t.Number()]) };",
      ].join("\n"),
      {
        sourcePath: "apps/api/src/handlers/new/list.ts",
        ruleOptions: { allowedFiles: ["apps/api/src/handlers/legacy/list.ts"] },
      },
    ),
  ).toEqual([1, 2, 3, 4]);
});
