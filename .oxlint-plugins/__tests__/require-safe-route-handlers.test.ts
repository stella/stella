import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("require-safe-route-handlers", lines.join("\n"));

test("rejects thin, hand-built and local non-factory definitions", async () => {
  expect(
    await lint([
      'import { defineEndpoint } from "@/api/lib/endpoints";',
      'import { wrap } from "@/api/lib/wrap";',
      "const local = defineEndpoint.public({}, () => ({}));",
      "export const r = routes({",
      '  "/a": { GET: defineEndpoint.member({}, handler) },',
      '  "/b": { POST: { config: {}, access: "public", run } },',
      '  "/c": { PUT: local },',
      '  "/d": { PATCH: () => ({}) },',
      '  "/e": { DELETE: wrap(defineEndpoint.public({}, handler)) },',
      '  "/f": { OPTIONS: flag ? local : local },',
      "});",
      "",
    ]),
  ).toEqual([5, 6, 7, 8, 9, 10]);
});

test("accepts imported endpoints, injected builders and factory-built consts", async () => {
  expect(
    await lint([
      'import readThing from "@/api/handlers/things/read";',
      'import { createThing } from "@/api/handlers/things/create";',
      'import { createSafeHandler } from "@/api/lib/api-handlers";',
      "const updateThing = createSafeHandler(config, run);",
      "const { listThings } = createThing(options);",
      "const methods = { GET: readThing, POST: createThing(options) };",
      "export const r = routes(",
      "  {",
      '    "/": methods,',
      '    "/:id": { GET: readThing, PATCH: updateThing },',
      '    "/list": { GET: listThings },',
      '    "/x": { POST: options ? createThing(options) : readThing },',
      "  },",
      '  { prefix: "/things" },',
      ");",
      "",
    ]),
  ).toEqual([]);
});

test("reports route tables the rule cannot read", async () => {
  expect(
    await lint([
      'import readThing from "@/api/handlers/things/read";',
      'import { sharedTable } from "@/api/handlers/things/table";',
      "export const a = routes(sharedTable);",
      "export const b = routes({",
      "  ...otherTable,",
      '  "/x": { ...otherMethods, GET: readThing },',
      '  "/y": buildMethods(),',
      "});",
      "",
    ]),
  ).toEqual([3, 5, 6, 7]);
});

test("reads routes() wherever it is called, and no other call", async () => {
  expect(
    await lint([
      'export const m = mount([routes({ "/": { GET: readThing } })]);',
      'export const n = table({ "/": { GET: () => ({}) } });',
      "",
    ]),
  ).toEqual([1]);
});
