import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule("no-forced-database-drop", [...lines, ""].join("\n"), {
    plugin: "bun-test-hygiene",
    sourcePath: "suite.test.ts",
  });

describe.serial(
  "fixture database teardown closes clients before normal drops",
  () => {
    test("rejects forced drops in strings, interpolated identifiers and SQL batches", async () => {
      expect(
        await lint(
          "declare const databaseName: string;",
          'export const first = "DROP DATABASE fixture WITH (FORCE)";',
          `export const second = \`drop database "\${databaseName}" with /* option */ (force)\`;`,
          'export const third = "SELECT 1; DROP DATABASE IF EXISTS fixture WITH (FORCE)";',
        ),
      ).toEqual([2, 3, 4]);
    });

    test("decoded JavaScript escapes retain the SQL teardown rule", async () => {
      expect(
        await lint(
          'export const query = "\\u0044ROP DATABASE fixture WITH (\\u0046ORCE)";',
        ),
      ).toEqual([1]);
    });

    test("accepts normal drops and unrelated FORCE text", async () => {
      expect(
        await lint(
          "declare const databaseName: string;",
          'export const first = "DROP DATABASE IF EXISTS fixture";',
          `export const second = \`DROP DATABASE "\${databaseName}"\`;`,
          'export const other = "ALTER TABLE fixture FORCE ROW LEVEL SECURITY";',
          "export const quoted = \"SELECT 'value; DROP DATABASE fixture WITH (FORCE)'\";",
        ),
      ).toEqual([]);
    });
  },
);
