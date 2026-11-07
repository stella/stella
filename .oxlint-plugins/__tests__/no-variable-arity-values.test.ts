// oxlint-disable no-template-curly-in-string -- these strings are the linted source, not templates.
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects a VALUES list interpolated into a statement", async () => {
  expect(
    await lintSingleRule(
      "no-variable-arity-values",
      [
        "declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;",
        "declare const rows: unknown;",
        "export const a = sql`WITH e(id) AS (VALUES ${rows}) SELECT * FROM e`;",
        "export const b = sql`INSERT INTO t (id) values ${rows}`;",
        "export const c = sql`SELECT * FROM (VALUES",
        "  ${rows}) AS e(id)`;",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5]);
});

test("allows one parameter and VALUES with a fixed list in the text", async () => {
  expect(
    await lintSingleRule(
      "no-variable-arity-values",
      [
        "declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;",
        "declare const payload: string;",
        "declare const ids: string[];",
        "declare const version: string;",
        "export const a = sql`SELECT * FROM jsonb_to_recordset(${payload}::text::jsonb) AS row(id uuid)`;",
        "export const b = sql`SELECT * FROM t WHERE id = ANY(${ids}::uuid[])`;",
        "export const c = sql`INSERT INTO t (version) VALUES (${version})`;",
      ].join("\n"),
    ),
  ).toEqual([]);
});
