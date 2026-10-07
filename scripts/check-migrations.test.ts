import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = readFileSync(
  path.join(import.meta.dir, "check-migrations.sh"),
  "utf-8",
);
// Exercise the shell's source comparison directly, including its git base lookup.
const comparison =
  /^schema_file_has_migration_relevant_diff\(\) \{[\s\S]*?^\}/mu
    .exec(script)
    ?.at(0);
if (!comparison) {
  panic("Migration source comparison was not found");
}
const baseSource = 'export const value = text("value").notNull();\n';

const compareSources = (
  sources: readonly string[],
  initialSource = baseSource,
) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "migration-source-"));
  const runGit = (...arguments_: string[]) => {
    const result = Bun.spawnSync(["git", ...arguments_], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  };
  try {
    writeFileSync(path.join(cwd, "schema.ts"), initialSource);
    runGit("init", "-b", "main");
    runGit("config", "user.name", "Test User");
    runGit("config", "user.email", "test@example.com");
    runGit("config", "commit.gpgsign", "false");
    runGit("add", "schema.ts");
    runGit("commit", "-m", "Initial schema");
    symlinkSync(
      path.resolve(import.meta.dir, "../node_modules"),
      path.join(cwd, "node_modules"),
      "dir",
    );
    return sources.map((source) => {
      writeFileSync(path.join(cwd, "schema.ts"), source);
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          `${comparison}\nschema_file_has_migration_relevant_diff schema.ts`,
        ],
        {
          cwd,
          env: { ...process.env, BASE_REF: "main" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.stderr.toString()).toBe("");
      return result.exitCode;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

describe("migration source comparison", () => {
  test("ignores type-only calls across formatting and nested type arguments", () => {
    expect(
      compareSources([
        'import type { Brand } from "./brand";\nexport const value = text("value").$type<Brand>().notNull();',
        'import type {\n  Brand\n} from "./brand";\nexport const value = text("value")\n.$type<Record<string, Array<Brand>>>()\n.notNull();',
        'export const value = text("value").$type<{ nested: { value: string } }>().notNull().$type<string>();',
        'export const value = text("value").$type<"a" | "b">().notNull();',
        baseSource,
      ]),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  test("preserves runtime differences alongside type-only calls", () => {
    expect(
      compareSources([
        'export const value = text("renamed").$type<string>().notNull();',
        'export const value = text("value").$type<string>();',
        'export const value = text("value").$type<string>().default(sql`1 > 0`).notNull();',
        'export const value = text("value").$type<string>(runtimeValue).notNull();',
        'export const value = text("value").$type().notNull();',
        'export const value = text("value").$type<string>()?.notNull();',
      ]),
    ).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("preserves SQL template text containing type-call syntax", () => {
    const source =
      'export const value = text("value").default(sql`.$type<A>() > 0`).notNull();';
    expect(
      compareSources(
        [
          'export const value = text("value").$type<string>().default(sql`.$type<A>() > 0`).notNull();',
          'export const value = text("value").$type<string>().default(sql`.$type<B>() > 0`).notNull();',
        ],
        source,
      ),
    ).toEqual([1, 0]);
  });

  // 1.2 s serial, 4.9 s observed while CI runs checks in parallel.
  test("ignores type-only named import changes while retaining value imports", () => {
    const source = `import { text, type Brand } from "drizzle-orm/pg-core";\n${baseSource}`;
    expect(
      compareSources(
        [
          `import { text, type OtherBrand } from "drizzle-orm/pg-core";\n${
            baseSource
          }`,
          `import { text, type Brand as OtherBrand } from "drizzle-orm/pg-core";\n${
            baseSource
          }`,
          `import { text } from "drizzle-orm/pg-core";\n${baseSource}`,
          `import { type Brand, text, type OtherBrand } from "drizzle-orm/pg-core";\n${
            baseSource
          }`,
          `import { text, Brand } from "drizzle-orm/pg-core";\n${baseSource}`,
          `import { varchar, type Brand } from "drizzle-orm/pg-core";\n${
            baseSource
          }`,
          `import { text as otherText, type Brand } from "drizzle-orm/pg-core";\n${
            baseSource
          }`,
          `import { text, type Brand } from "other-module";\n${baseSource}`,
        ],
        source,
      ),
    ).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  }, 12_000);
});
