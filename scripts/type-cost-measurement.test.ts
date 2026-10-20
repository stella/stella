import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

test("measurement selects existing individual programs and refuses unknown or duplicate targets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "type-cost-projects-"));
  try {
    mkdirSync(path.join(root, "packages/leaf"), { recursive: true });
    mkdirSync(path.join(root, "apps"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "root",
        scripts: {
          "typecheck:repo": "bun check --project=tsconfig.scripts.json",
        },
      }),
    );
    writeFileSync(path.join(root, "tsconfig.scripts.json"), "{}");
    writeFileSync(
      path.join(root, "packages/leaf/package.json"),
      JSON.stringify({
        name: "@stll/leaf",
        scripts: {
          typecheck:
            "bun check --project=tsconfig.json && bun check --project=tsconfig.tests.json",
          "typecheck:again": "bun check --project=tsconfig.json",
          test: "bun check --project=ignored.json",
        },
      }),
    );
    for (const file of ["tsconfig.json", "tsconfig.tests.json"]) {
      writeFileSync(path.join(root, "packages/leaf", file), "{}");
    }
    const select = (targets: string) =>
      Bun.spawnSync(
        ["python3", "scripts/type-cost-projects.py", "--root", root],
        { env: { ...process.env, TYPE_COST_PROJECTS: targets } },
      );
    const result = select("");
    expect(result.exitCode).toBe(0);
    const matrix = v.parse(
      v.object({
        include: v.array(
          v.object({
            id: v.string(),
            project: v.string(),
            package: v.string(),
          }),
        ),
      }),
      JSON.parse(result.stdout.toString()),
    );
    expect(matrix.include.map(({ project }) => project)).toEqual([
      "packages/leaf/tsconfig.json",
      "packages/leaf/tsconfig.tests.json",
      "tsconfig.scripts.json",
    ]);
    expect(new Set(matrix.include.map(({ id }) => id)).size).toBe(3);
    expect(select("packages/leaf/tsconfig.json").exitCode).toBe(0);
    for (const target of [
      "../other/tsconfig.json",
      "tsconfig.json",
      "$(command)",
    ]) {
      const refused = select(target);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("existing typecheck scripts");
    }
    const duplicate = select("tsconfig.scripts.json tsconfig.scripts.json");
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr.toString()).toContain("Duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler measurements only dispatch manually and serialize individual traced checks", () => {
  const text = readFileSync(
    new URL("../.github/workflows/type-cost-measurement.yml", import.meta.url),
    "utf-8",
  );
  const workflow = v.parse(
    v.looseObject({
      on: v.record(v.string(), v.unknown()),
      permissions: v.record(v.string(), v.string()),
      concurrency: v.object({
        group: v.string(),
        "cancel-in-progress": v.boolean(),
      }),
      jobs: v.looseObject({
        prepare: v.looseObject({
          steps: v.array(
            v.looseObject({
              run: v.optional(v.string()),
              "working-directory": v.optional(v.string()),
            }),
          ),
        }),
        measure: v.looseObject({
          "runs-on": v.string(),
          strategy: v.looseObject({ "max-parallel": v.number() }),
          steps: v.array(v.looseObject({ run: v.optional(v.string()) })),
        }),
      }),
    }),
    Bun.YAML.parse(text),
  );
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({
    group: "type-cost-measurement",
    "cancel-in-progress": false,
  });
  expect(workflow.jobs.measure["runs-on"]).toBe("ubuntu-24.04");
  expect(workflow.jobs.measure.strategy["max-parallel"]).toBe(1);
  const runs = workflow.jobs.measure.steps
    .flatMap(({ run }) => (run ? [run] : []))
    .join("\n");
  expect(runs).toContain('--project "$TYPE_COST_PROJECT"');
  expect(runs).toContain("--incremental false --extendedDiagnostics");
  expect(runs).toContain('--generateTrace "$output/trace"');
  expect(runs).toContain('/usr/bin/time -v -o "$output/rss.txt"');
  expect(runs).toContain('exit "$status"');
  expect(runs).not.toMatch(/\$\{\{\s*(?:inputs|matrix)\./u);
  const extensionPreparation = workflow.jobs.prepare.steps.filter(({ run }) =>
    run?.includes("wxt prepare"),
  );
  expect(extensionPreparation).toHaveLength(1);
  for (const step of extensionPreparation) {
    expect(step["working-directory"]).toBe("apps/extension");
  }
});
