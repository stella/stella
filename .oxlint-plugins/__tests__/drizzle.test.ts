import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const PLUGIN_NAME = "drizzle";
const RULE_OPTIONS = { drizzleObjectName: ["db", "tx"] };

setDefaultTimeout(20_000);

const lintRule = async (rule: string, source: string) =>
  await lintSingleRule(rule, `${source}\n`, {
    plugin: PLUGIN_NAME,
    ruleOptions: RULE_OPTIONS,
    sourcePath: "mutation.ts",
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const lintDeleteAcrossFiles = async (sources: readonly string[]) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-drizzle-where-"));
  try {
    const configPath = path.join(directory, "oxlint.config.ts");
    const jsPlugin = path.join(
      REPOSITORY_ROOT,
      ".oxlint-plugins",
      "drizzle.ts",
    );
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [jsPlugin],
        rules: {
          "drizzle/enforce-delete-with-where": ["error", RULE_OPTIONS],
        },
      })};\n`,
    );
    const sourcePaths = await Promise.all(
      sources.map(async (source, index) => {
        const sourcePath = path.join(directory, `source-${index}.ts`);
        await Bun.write(sourcePath, `${source}\n`);
        return sourcePath;
      }),
    );
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        configPath,
        "-f",
        "json",
        ...sourcePaths,
      ],
      { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    const report = Result.try((): unknown => JSON.parse(stdout));
    if (Result.isError(report)) {
      return panic(
        `oxlint did not produce valid JSON:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const diagnostics = isRecord(report.value)
      ? report.value.diagnostics
      : undefined;
    if (!isUnknownArray(diagnostics)) {
      return panic(
        `oxlint reported no diagnostics array:\n${stdout}\n${stderr}`,
      );
    }
    return diagnostics.filter(
      (diagnostic) =>
        isRecord(diagnostic) &&
        typeof diagnostic.code === "string" &&
        diagnostic.code.startsWith("drizzle(enforce-delete-with-where)"),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

describe("Drizzle mutation where enforcement", () => {
  test("requires filters on delete and update while accepting filtered mutations", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      ["db.delete(users);", "db.delete(users).where(eq(users.id, id));"].join(
        "\n",
      ),
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      [
        "db.update(users).set({ name });",
        "db.update(users).set({ name }).where(eq(users.id, id));",
      ].join("\n"),
    );

    expect(deleteLines).toEqual([1]);
    expect(updateLines).toEqual([1]);
  });

  test("does not borrow an unrelated preceding where", async () => {
    const lines = await lintRule(
      "enforce-delete-with-where",
      ["db.select().where(eq(users.id, id));", "db.delete(users);"].join("\n"),
    );

    expect(lines).toEqual([2]);
  });

  test("does not borrow a where from an enclosing call", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      "wrap(db.delete(users)).where(eq(users.id, id));",
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      "wrap(db.update(users).set({ name })).where(eq(users.id, id));",
    );

    expect(deleteLines).toEqual([1]);
    expect(updateLines).toEqual([1]);
  });

  test("accepts returning after the mutation's own where", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      "db.delete(users).where(eq(users.id, id)).returning();",
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      "db.update(users).set({ name }).where(eq(users.id, id)).returning();",
    );

    expect(deleteLines).toEqual([]);
    expect(updateLines).toEqual([]);
  });

  test("keeps each file's filter state local within one oxlint run", async () => {
    const safeThenUnsafe = await lintDeleteAcrossFiles([
      "db.delete(users).where(eq(users.id, id));",
      "db.delete(users);",
    ]);
    const unsafeThenSafe = await lintDeleteAcrossFiles([
      "db.delete(users);",
      "db.delete(users).where(eq(users.id, id));",
    ]);

    expect(safeThenUnsafe).toHaveLength(1);
    expect(unsafeThenSafe).toHaveLength(1);
  });
});

describe("entity parent mutation ownership", () => {
  test("routes explicit parent updates to the serialized move owner", async () => {
    const source = [
      "tx.update(entities).set({ parentId }).where(filter);",
      "tx.update(entities).set({ name }).where(filter);",
      "tx.update(otherTable).set({ parentId }).where(filter);",
      "tx.update(entities).set({ ['parentId']: id }).where(filter);",
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-entity-reparent", source, {
        plugin: PLUGIN_NAME,
        sourcePath: "apps/api/src/handlers/entities/other.ts",
      }),
    ).toEqual([1, 4]);
    expect(
      await lintSingleRule("no-direct-entity-reparent", source, {
        plugin: PLUGIN_NAME,
        sourcePath: "apps/api/src/handlers/entities/move.ts",
      }),
    ).toEqual([]);
  });
});
