import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DRIZZLE_CONFIG, readDrizzleSchemaConfig } from "./drizzle-config";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const withConfig = (source: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "drizzle-config-"));
  roots.push(root);
  mkdirSync(path.join(root, "apps/api"), { recursive: true });
  writeFileSync(path.join(root, DRIZZLE_CONFIG), source);
  return root;
};

test("the repository config resolves to its schema files and filter", () => {
  const config = readDrizzleSchemaConfig(path.resolve(import.meta.dir, ".."));
  expect(config.schemaFiles).toContain("apps/api/src/db/schema.ts");
  expect(config.schemaFilter).toEqual(["public"]);
});

test("a config without a schema filter uses drizzle-kit's public default", () => {
  const root = withConfig(
    'export default defineConfig({ schema: ["./src/db/schema.ts"], dbCredentials: { url } });\n',
  );
  expect(readDrizzleSchemaConfig(root)).toEqual({
    schemaFiles: ["apps/api/src/db/schema.ts"],
    schemaFilter: ["public"],
  });
});

test("a schema entry the reader cannot resolve statically fails instead of being dropped", () => {
  for (const schema of [
    '[...SCHEMA_FILES, "./src/db/schema.ts"]',
    '[SCHEMA, "./src/db/schema.ts"]',
    '["./src/db/schema/*"]',
    "SCHEMA_FILES",
    "[]",
  ]) {
    const root = withConfig(
      `export default defineConfig({ schema: ${schema} });\n`,
    );
    expect(() => readDrizzleSchemaConfig(root), schema).toThrow(DRIZZLE_CONFIG);
  }
  for (const config of [
    'export default defineConfig({ ...base, schema: ["./src/db/schema.ts"] });\n',
    'export default defineConfig({ schema: ["./src/db/schema.ts"], schemaFilter: FILTER });\n',
    "export default defineConfig(config);\n",
  ]) {
    expect(() => readDrizzleSchemaConfig(withConfig(config)), config).toThrow(
      DRIZZLE_CONFIG,
    );
  }
});

test("a commented-out entry is not a schema input", () => {
  const root = withConfig(
    'export default defineConfig({\n  schema: [\n    "./src/db/schema.ts",\n    // "./src/db/old.ts",\n  ],\n});\n',
  );
  expect(readDrizzleSchemaConfig(root).schemaFiles).toEqual([
    "apps/api/src/db/schema.ts",
  ]);
});
