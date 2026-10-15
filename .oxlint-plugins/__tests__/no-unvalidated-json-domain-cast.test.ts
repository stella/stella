import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw JSON assertions satisfies claims and generic response claims", async () => {
  expect(
    await lintSingleRule(
      "no-unvalidated-json-domain-cast",
      'type Company = { id: string };\nJSON.parse(raw) as Company;\nJSON["parse"](raw) satisfies Company;\nasync function read() { return response.json<Company>(); }',
      { sourcePath: "apps/api/src/lib/registry.ts" },
    ),
  ).toEqual([2, 3, 4]);
});

test("rejects typed variables and typed member assignments", async () => {
  expect(
    await lintSingleRule(
      "no-unvalidated-json-domain-cast",
      "type Company = { id: string };\nconst company: Company = JSON.parse(raw);\nconst state: { company: Company; raw: unknown } = { company: JSON.parse(raw), raw: null };\nstate.company = JSON.parse(raw);",
      { sourcePath: "apps/api/src/lib/registry.ts" },
    ),
  ).toEqual([2, 3, 4]);
});

test("follows parser and raw payload aliases before closed claims", async () => {
  expect(
    await lintSingleRule(
      "no-unvalidated-json-domain-cast",
      "type Company = { id: string };\nconst parse = JSON.parse;\nconst value = parse(raw);\nconst company: Company = value;",
      { sourcePath: "apps/api/src/lib/registry.ts" },
    ),
  ).toEqual([4]);
});

test("accepts unknown JSON passthrough and runtime parsing", async () => {
  expect(
    await lintSingleRule(
      "no-unvalidated-json-domain-cast",
      "const payload: unknown = JSON.parse(raw);\nconst json: JsonValue = JSON.parse(raw);\nv.parse(schema, JSON.parse(raw));\nv.safeParse(schema, JSON.parse(raw));",
      { sourcePath: "apps/api/src/lib/registry.ts" },
    ),
  ).toEqual([]);
});

test("leaves test fixtures outside production scope", async () => {
  expect(
    await lintSingleRule(
      "no-unvalidated-json-domain-cast",
      "JSON.parse(raw) as Company;",
      { sourcePath: "apps/api/src/tests/registry.test.ts" },
    ),
  ).toEqual([]);
});
