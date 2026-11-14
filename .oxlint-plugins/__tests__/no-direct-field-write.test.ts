import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/api/src/handlers/chat/tools/workspace-tools.ts",
) =>
  await lintSingleRule("no-direct-field-write", [...lines, ""].join("\n"), {
    sourcePath,
  });

const writeSource = [
  'import { cellMetadata, fields } from "@/api/db/schema";',
  "declare const tx: {",
  "  insert: (table: unknown) => unknown;",
  "  update: (table: unknown) => unknown;",
  "  delete: (table: unknown) => unknown;",
  "};",
  "export const a = [",
  "  tx.insert(fields),",
  "  tx.update(fields),",
  "  tx.delete(fields),",
  "  tx.insert(cellMetadata),",
  "];",
];

describe.serial("no-direct-field-write", () => {
  test("reports field table writes outside the owner", async () => {
    expect(await lint(writeSource)).toEqual([8, 9, 10, 11]);
    expect(
      await lint(writeSource, "apps/api/src/mcp/document-tools.ts"),
    ).toEqual([8, 9, 10, 11]);
  });

  test("follows an aliased import and ignores unrelated locals", async () => {
    expect(
      await lint([
        'import { fields as cells } from "@/api/db/schema";',
        'import type { fields as typeOnly } from "@/api/db/schema";',
        "declare const tx: { insert: (table: unknown) => unknown };",
        "declare const fields: unknown;",
        "declare const entities: unknown;",
        "export const b = [",
        "  tx.insert(cells),",
        "  tx.insert(fields),",
        "  tx.insert(entities),",
        "];",
        "export type T = typeof typeOnly;",
      ]),
    ).toEqual([7]);
  });

  test("leaves the owner, the listed writers and tests alone", async () => {
    const results = await Promise.all(
      [
        "apps/api/src/lib/fields/write-field.ts",
        "apps/api/src/lib/workflow-queue.ts",
        "apps/api/src/handlers/fields/cell-metadata/update.ts",
        "apps/api/src/handlers/chat/tools/workspace-tools.test.ts",
        "apps/api/src/tests/security/rls-helpers.ts",
      ].map(async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(writeSource, sourcePath),
          expected: [],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("reports a sibling of the owner module", async () => {
    expect(
      await lint(writeSource, "apps/api/src/lib/fields/another-writer.ts"),
    ).not.toEqual([]);
  });

  test("reports nothing on the API's own field writers", async () => {
    // Every production module that writes the field tables today is the
    // owner or a listed writer, so the rule holds without suppressions.
    const root = path.resolve(import.meta.dir, "../..");
    const apiSource = path.join(root, "apps/api/src");
    const writePattern =
      /\.(?:insert|update|delete)\(\s*(?:fields|cellMetadata)\s*\)/u;
    const modules = readdirSync(apiSource, { recursive: true })
      .map(String)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.startsWith("tests/"),
      )
      .map((file) => path.join(apiSource, file))
      .filter((file) => writePattern.test(readFileSync(file, "utf-8")));
    expect(modules.length).toBeGreaterThan(0);

    const results = await Promise.all(
      modules.map(async (file) => {
        const relative = repoRelativePath(root, file);
        const lines = await lintSingleRule(
          "no-direct-field-write",
          readFileSync(file, "utf-8"),
          { sourcePath: relative },
        );
        return { label: relative, result: lines };
      }),
    );
    expect(results).toEqual(
      modules.map((file) => ({
        label: repoRelativePath(root, file),
        result: [],
      })),
    );
  });
});
