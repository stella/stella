import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("one-statement-time-per-row-write", source, {
    sourcePath: "source.ts",
  });

const PRELUDE =
  "declare const sql: any; declare const db: any; declare const ttl: number;\n";

test("rejects a second clock_timestamp() column in one row write", async () => {
  expect(
    await lint(
      `${PRELUDE}db.update(t).set({ expiresAt: sql\`clock_timestamp() + \${ttl}\`, updatedAt: sql\`clock_timestamp()\` });`,
    ),
  ).toEqual([2]);
  expect(
    await lint(
      `${PRELUDE}db.insert(t).values([{ a: sql\`clock_timestamp()\`, b: sql\`clock_timestamp()\` }]);`,
    ),
  ).toEqual([2]);
  expect(
    await lint(
      `${PRELUDE}transition({ options: { set: {\n  attestedAt: sql\`clock_timestamp()\`,\n  updatedAt: sql\`clock_timestamp()\`,\n} } });`,
    ),
  ).toEqual([4]);
});

test("allows one clock read per row write, statement_timestamp(), and reads outside writes", async () => {
  expect(
    await lint(
      [
        PRELUDE.trimEnd(),
        "db.update(t).set({ updatedAt: sql`clock_timestamp()`, status: 'done' });",
        `db.update(t).set({ expiresAt: sql\`statement_timestamp() + \${ttl}\`, updatedAt: sql\`statement_timestamp()\` });`,
        "export const read = { a: sql`clock_timestamp()`, b: sql`clock_timestamp()` };",
      ].join("\n"),
    ),
  ).toEqual([]);
});
