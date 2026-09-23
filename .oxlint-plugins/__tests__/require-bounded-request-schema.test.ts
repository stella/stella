import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("require-bounded-request-schema", lines.join("\n"));

describe.serial("require-bounded-request-schema", () => {
  test("reports unbounded strings and arrays in every request slot", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: t.Object({ name: t.String() }),",
        "  query: t.Object({ ids: t.Array(tUuid) }),",
        "  params: workspaceParams({ slug: t.String({ minLength: 1 }) }),",
        "  headers: t.Object({ agent: t.Optional(t.String()) }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([2, 3, 4, 5]);
  });

  test("follows same-file bindings into the request schema", async () => {
    expect(
      await lint([
        "const item = t.Object({ note: t.String() });",
        "const listBody = t.Object({ items: t.Array(item, { maxItems: 10 }) });",
        "export default { config: { body: listBody }, handler };",
        "",
      ]),
    ).toEqual([1]);
  });

  test("reads named request schemas whose config is in another file", async () => {
    expect(
      await lint([
        "export const tRenameBody = t.Object({ name: t.String() });",
        "const searchQuerySchema = t.Object({ q: t.Nullable(t.String()) });",
        "const createParams = t.Object({ id: t.String({ format: 'date-time' }) });",
        "",
      ]),
    ).toEqual([1, 2, 3]);
  });

  test("accepts bounded, fixed-width, and unprovable options", async () => {
    expect(
      await lint([
        "createSafeHandler({",
        "  body: t.Object({",
        "    name: t.String({ maxLength: 256 }),",
        "    day: t.String({ format: 'date' }),",
        "    id: t.String({ format: 'uuid' }),",
        "    shared: tDefaultVarchar,",
        "    opaque: t.String(options),",
        "    spread: t.String({ ...options }),",
        "    tags: t.Array(tDefaultVarchar, { maxItems: 20 }),",
        "    cursor: t.Optional(t.String()),",
        "    upload: t.File({ maxSize: '5m' }),",
        "  }),",
        "}, handler);",
        "",
      ]),
    ).toEqual([]);
  });

  test("ignores response and non-request schemas", async () => {
    expect(
      await lint([
        "createSafeHandler({ response: t.Object({ html: t.String() }) }, h);",
        "const rowSchema = t.Object({ body: t.String(), list: t.Array(t.String()) });",
        "const detailResponseSchema = t.Object({ query: t.String() });",
        "const init = { body: JSON.stringify(payload), headers: { a: 'b' } };",
        "const build = () => { const listQuery = t.Object({ q: t.String() }); };",
        "",
      ]),
    ).toEqual([]);
  });
});
