import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { schemaEntries, schemaImportsChanged } from "./schema-import-changes";

const root = path.resolve(import.meta.dir, "..");

test("the schema entries are the files drizzle-kit reads", () => {
  const config = readFileSync(
    path.join(root, "apps/api/drizzle.config.ts"),
    "utf-8",
  );
  const entries = schemaEntries(root);
  expect(entries).toContain("apps/api/src/db/schema.ts");
  for (const entry of entries) {
    expect(config).toContain(`./${entry.replace(/^apps\/api\//u, "")}`);
  }
});

test("a value the schema imports from outside the migration paths selects the migration jobs", () => {
  // The chat schema imports its turn statuses from an API library.
  expect(
    schemaImportsChanged({
      root,
      changed: ["apps/api/src/lib/chat/turn-status.ts"],
    }),
  ).toBe(true);
  expect(
    schemaImportsChanged({ root, changed: ["docs/architecture.md"] }),
  ).toBe(false);
});

const MIGRATION_INPUTS = [
  "MIGRATION_PATHS",
  "SCHEMA_IMPORTS",
  "SCHEMA_IMPORTS_FALLBACK",
] as const;

test("the plan requires the migration jobs when any migration input says so", () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        "ci-plan": v.object({
          outputs: v.object({ database_migrations_required: v.string() }),
          steps: v.array(
            v.looseObject({
              id: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  const plan = workflow.jobs["ci-plan"];
  expect(plan.outputs.database_migrations_required).toBe(
    `\${{ steps.migration-scope.outputs.database_migrations_required }}`,
  );
  const script =
    plan.steps.find((candidate) => candidate.id === "migration-scope")?.run ??
    panic("Missing the migration-scope step");
  const directory = mkdtempSync(path.join(tmpdir(), "migration-scope-"));
  try {
    // A skipped step leaves its output empty.
    const answers = ["", "false", "true"];
    for (const paths of answers) {
      for (const graph of answers) {
        for (const fallback of answers) {
          const values = [paths, graph, fallback];
          const output = path.join(directory, "output");
          writeFileSync(output, "");
          const result = Bun.spawnSync(
            ["bash", "-euo", "pipefail", "-c", script],
            {
              env: {
                PATH: process.env["PATH"] ?? "",
                GITHUB_OUTPUT: output,
                ...Object.fromEntries(
                  MIGRATION_INPUTS.map((name, index) => [
                    name,
                    values[index] ?? "",
                  ]),
                ),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          expect(readFileSync(output, "utf-8"), JSON.stringify(values)).toBe(
            `database_migrations_required=${String(values.includes("true"))}\n`,
          );
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
