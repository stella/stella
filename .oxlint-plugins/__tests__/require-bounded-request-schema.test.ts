import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("require-bounded-request-schema", lines.join("\n"));

describe.serial("require-bounded-request-schema", () => {
  test("reports unbounded strings, lists and records in every request slot", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: v.object({ name: v.string() }),",
        "  query: v.object({ ids: arrayFromQuery(uuidSchema) }),",
        "  params: workspaceParams({ slug: v.pipe(v.string(), v.minLength(1)) }),",
        "  headers: v.object({ agent: v.optional(v.string()) }),",
        "}, handler);",
        "defineEndpoint.public({",
        "  body: v.object({ tags: v.array(defaultVarcharSchema) }),",
        "  query: v.object({ meta: v.record(v.string(), v.number()) }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([2, 3, 4, 5, 8, 9]);
  });

  test("follows same-file bindings into the request schema", async () => {
    expect(
      await lint([
        "const item = v.object({ note: v.string() });",
        "const listBody = v.object({ items: v.pipe(v.array(item), v.maxLength(10)) });",
        "export default createSafeHandler({ body: listBody }, handler);",
        "",
      ]),
    ).toEqual([1]);
  });

  test("reads named request schemas whose config is in another file", async () => {
    expect(
      await lint([
        "export const renameBodySchema = v.object({ name: v.string() });",
        "const searchQuerySchema = v.object({ q: v.nullable(v.string()) });",
        "const createParams = v.object({ at: v.pipe(v.string(), v.isoTimestamp()) });",
        "",
      ]),
    ).toEqual([1, 2, 3]);
  });

  test("accepts bounded, fixed-width, helper-built and unprovable schemas", async () => {
    expect(
      await lint([
        "const NAME = v.maxLength(256);",
        "createSafeHandler({",
        "  body: v.object({",
        "    name: v.pipe(v.string(), v.trim(), v.maxLength(256)),",
        "    named: v.pipe(v.string(), NAME),",
        "    day: v.pipe(v.string(), v.isoDate()),",
        "    id: v.pipe(v.string(), v.uuid()),",
        "    optional: v.pipe(v.optional(v.string()), v.maxLength(8)),",
        "    shared: defaultVarcharSchema,",
        "    described: withDescription(userIdSchema, 'The user'),",
        "    spread: v.pipe(v.string(), ...steps),",
        "    tags: v.pipe(v.array(defaultVarcharSchema), v.maxLength(20)),",
        "    meta: v.pipe(v.record(v.string(), v.number()), v.maxEntries(20)),",
        "    kind: v.picklist(['a', 'b']),",
        "    cursor: v.optional(v.string()),",
        "    upload: fileSchema({ maxBytes: 5 }),",
        "    raw: v.pipe(v.file(), v.maxSize(5)),",
        "  }),",
        "  query: v.object({",
        "    limit: v.exactOptional(numberFromString(paginationLimitSchema(50))),",
        "    ids: v.pipe(arrayFromQuery(uuidSchema), v.maxLength(10)),",
        "    flag: v.optional(booleanFromString()),",
        "  }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([]);
  });

  test("reports files without a size limit", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: v.object({",
        "    upload: v.file(),",
        "    blob: v.optional(v.blob()),",
        "    many: v.pipe(v.array(fileSchema({ maxBytes: 5 })), v.maxLength(5)),",
        "  }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([3, 4]);
  });

  test("bounds of a pipe do not reach the fields or items inside it", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: v.pipe(",
        "    v.object({ items: v.array(v.string()) }),",
        "    v.maxLength(5),",
        "  ),",
        "  query: v.object({ ids: v.pipe(v.array(v.string()), v.maxLength(5)) }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([3, 3, 6]);
  });

  test("an imported or computed pipe step proves no bound", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: v.object({",
        "    ids: v.pipe(v.array(uuidSchema), uniqueItems()),",
        "    note: v.pipe(v.string(), v.check(isShort)),",
        "    described: withDescription(v.string(), 'A note'),",
        "    parsed: jsonFromString(v.array(v.number())),",
        "  }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([3, 4, 5, 6]);
  });

  test("follows spread entries into the request schema", async () => {
    expect(
      await lint([
        "const common = { locale: v.string() };",
        "const base = v.object({ note: v.string() });",
        "export const sendBodySchema = v.strictObject({",
        "  ...common,",
        "  ...base.entries,",
        "  ok: v.pipe(v.string(), v.maxLength(5)),",
        "});",
        "",
      ]),
    ).toEqual([1, 2]);
  });

  test("follows const alias chains", async () => {
    expect(
      await lint([
        "const schema = v.object({ name: v.string() });",
        "const requestBody = schema;",
        "export default createSafeHandler({ body: requestBody }, handler);",
        "",
      ]),
    ).toEqual([1]);
  });

  test("judges a shared schema under each pipe that reaches it", async () => {
    expect(
      await lint([
        "const note = v.string();",
        "createSafeHandler({",
        "  body: v.object({ a: v.pipe(note, v.maxLength(3)), b: note }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([1]);
  });

  test("walks cursor schemas the pagination rule does not report", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  query: v.object({",
        "    cursor: v.union([v.literal('first'), v.string()]),",
        "  }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([3]);
  });

  test("ignores response and non-request schemas", async () => {
    expect(
      await lint([
        "createSafeHandler({ response: { 200: v.object({ html: v.string() }) } }, h);",
        "const rowSchema = v.object({ body: v.string(), list: v.array(v.string()) });",
        "const detailResponseSchema = v.object({ query: v.string() });",
        "const init = { body: JSON.stringify(payload), headers: { a: 'b' } };",
        "const build = () => { const listQuery = v.object({ q: v.string() }); };",
        "",
      ]),
    ).toEqual([]);
  });
});
