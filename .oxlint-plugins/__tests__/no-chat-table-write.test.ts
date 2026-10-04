import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-chat-table-write", [...lines, ""].join("\n"), {
    sourcePath: "apps/api/src/handlers/chat/tools/workspace-tools.ts",
  });

const preamble = [
  'import { sql } from "drizzle-orm";',
  'import { entities } from "@/api/db/schema";',
  "type Handle = {",
  "  insert: (table: unknown) => unknown;",
  "  update: (table: unknown) => unknown;",
  "  delete: (table: unknown) => unknown;",
  "  select: () => unknown;",
  "  execute: (query: unknown) => unknown;",
  "};",
  "declare const db: Handle;",
  "declare const tx: Handle;",
  "declare const safeDb: (run: (tx: Handle) => unknown) => unknown;",
  "declare const writeFieldValue: (tx: Handle, value: string) => unknown;",
];
const lineAfterPreamble = (offset: number) => preamble.length + offset;

describe.serial("no-chat-table-write", () => {
  test("reports Drizzle writes on db, tx and safeDb handles", async () => {
    expect(
      await lint([
        ...preamble,
        "export const a = [",
        "  db.insert(entities),",
        "  tx.update(entities),",
        "  tx.delete(entities),",
        "  safeDb((tx) => tx.insert(entities)),",
        "  safeDb((inner: Handle) => inner.delete(entities)),",
        "];",
      ]),
    ).toEqual([2, 3, 4, 5, 6].map(lineAfterPreamble));
  });

  test("reports raw SQL writes, including through a const", async () => {
    expect(
      await lint([
        ...preamble,
        "const remove = sql`DELETE FROM entities WHERE id = 1`;",
        "export const b = [",
        "  tx.execute(sql`INSERT INTO entities (name) VALUES ('x')`),",
        "  db.execute(sql`UPDATE entities SET name = 'x'`),",
        "  tx.execute(remove),",
        "];",
      ]),
    ).toEqual([3, 4, 5].map(lineAfterPreamble));
  });

  test("accepts reads and calls into lib write primitives", async () => {
    expect(
      await lint([
        ...preamble,
        "export const c = [",
        "  tx.select(),",
        "  db.execute(sql`SELECT 1 FROM entities`),",
        "  safeDb((tx) => writeFieldValue(tx, 'x')),",
        "  new Map().delete('key'),",
        "];",
      ]),
    ).toEqual([]);
  });
});
