import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Each index is a projection of filenames, never a second owner of values. */
export const DB_REGISTRY_DIRECTORIES = [
  "apps/api/src/lib/db/read-budget-entries",
  "apps/api/src/lib/db/mcp-read-budget-entries",
  "apps/api/src/lib/db/aggregate-lock-entries",
  "apps/api/src/lib/db/aggregate-chain-entries",
  "apps/api/src/tests/query-perf/profile-entries",
  "apps/api/src/tests/query-perf/scheduled-job-entries",
  "apps/api/src/tests/query-perf/deadline-entries",
  "apps/api/src/tests/query-perf/tenant-statement-entries",
  "apps/api/src/tests/query-perf/corpus-statement-entries",
] as const;

export const registryEntryNames = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".gen.ts"))
    .map((name) => name.slice(0, -3))
    .toSorted();

export const renderRegistryIndex = (directory: string) => {
  const names = registryEntryNames(directory);
  for (const name of names) {
    assert.match(
      name,
      /^[a-zA-Z][a-zA-Z0-9_.-]*$/u,
      `Invalid registry entry filename: ${name}`,
    );
  }
  return [
    ...names.map(
      (name, index) =>
        `import entry${index} from ${JSON.stringify(`./${name}`)};`,
    ),
    "",
    "export default {",
    ...names.map((name, index) => `  ${JSON.stringify(name)}: entry${index},`),
    "} as const;",
    "",
  ].join("\n");
};

export const renderAggregateIdentities = (directory: string) => {
  const names = registryEntryNames(directory);
  for (const name of names) {
    assert.match(
      name,
      /^[a-zA-Z][a-zA-Z0-9]*$/u,
      `Invalid aggregate identity filename: ${name}`,
    );
  }
  const entries = names.map((name) => ({
    name,
    alias: `${name.charAt(0).toUpperCase()}${name.slice(1)}Identity`,
  }));
  return [
    ...entries.map(
      ({ name, alias }) =>
        `import type { Identity as ${alias} } from "./${name}";`,
    ),
    "",
    "export type AggregateIdentities = {",
    ...entries.map(({ name, alias }) => `  ${JSON.stringify(name)}: ${alias};`),
    "};",
    "",
  ].join("\n");
};

const AGGREGATE_ENTRIES = "apps/api/src/lib/db/aggregate-lock-entries";

// These facades collect entries; writing values here recreates a shared edit point.
const REGISTRY_BINDINGS = [
  [
    "apps/api/src/lib/db/aggregate-lock.ts",
    "aggregateLocks",
    "./aggregate-lock-entries/registry.gen",
  ],
  [
    "apps/api/src/lib/db/aggregate-lock.ts",
    "aggregateChains",
    "./aggregate-chain-entries/registry.gen",
  ],
  [
    "apps/api/src/lib/db/read-budgets.ts",
    "readBudgets",
    "./read-budget-entries/registry.gen",
  ],
  [
    "apps/api/src/lib/db/read-budgets.ts",
    "mcpToolReadBudgets",
    "./mcp-read-budget-entries/registry.gen",
  ],
  [
    "apps/api/src/tests/query-perf/registry.ts",
    "readBudgetProfiles",
    "./profile-entries/registry.gen",
  ],
  [
    "apps/api/src/tests/query-perf/registry.ts",
    "scheduledJobMeasurements",
    "./scheduled-job-entries/registry.gen",
  ],
  [
    "apps/api/src/tests/query-perf/registry.ts",
    "tenantStatements",
    "./tenant-statement-entries/registry.gen",
  ],
  [
    "apps/api/src/tests/query-perf/registry.ts",
    "corpusStatements",
    "./corpus-statement-entries/registry.gen",
  ],
  [
    "apps/api/src/tests/query-perf/owner-deadlines.ts",
    "deadlines",
    "./deadline-entries/registry.gen",
  ],
] as const;

export const registryLayoutProblems = (root: string) => {
  const problems: string[] = [];
  for (const [file, binding, specifier] of REGISTRY_BINDINGS) {
    const source = readFileSync(path.join(root, file), "utf-8");
    if (!source.includes(`import ${binding} from "${specifier}";`)) {
      problems.push(`${file}: ${binding} must come from its entry index`);
    }
  }
  const queryFacade = readFileSync(
    path.join(root, "apps/api/src/tests/query-perf/registry.ts"),
    "utf-8",
  );
  const deadlineFacade = readFileSync(
    path.join(root, "apps/api/src/tests/query-perf/owner-deadlines.ts"),
    "utf-8",
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const queryRuntime = transpiler.transformSync(queryFacade);
  const deadlineRuntime = transpiler.transformSync(deadlineFacade);
  const lockRuntime = transpiler.transformSync(
    readFileSync(
      path.join(root, "apps/api/src/lib/db/aggregate-lock.ts"),
      "utf-8",
    ),
  );
  const budgetRuntime = transpiler.transformSync(
    readFileSync(
      path.join(root, "apps/api/src/lib/db/read-budgets.ts"),
      "utf-8",
    ),
  );
  for (const [runtime, exported, binding] of [
    [lockRuntime, "AGGREGATE_LOCKS", "aggregateLocks"],
    [lockRuntime, "AGGREGATE_CHAINS", "aggregateChains"],
    [budgetRuntime, "READ_BUDGETS", "readBudgets"],
    [budgetRuntime, "MCP_TOOL_READ_BUDGETS", "mcpToolReadBudgets"],
  ] as const) {
    if (!runtime.includes(`export const ${exported} = { ...${binding} };`)) {
      problems.push(
        `${exported}: project only the entry index without inline values`,
      );
    }
  }
  for (const [runtime, exported, binding] of [
    [queryRuntime, "READ_BUDGET_PROFILES", "readBudgetProfiles"],
    [queryRuntime, "SCHEDULED_JOB_MEASUREMENTS", "scheduledJobMeasurements"],
    [deadlineRuntime, "QUERY_PERF_OWNER_DEADLINES", "deadlines"],
  ] as const) {
    if (!runtime.includes(`export const ${exported} = ${binding};`)) {
      problems.push(
        `${exported}: collect the entry index without inline values`,
      );
    }
  }
  for (const [exported, binding] of [
    ["queryPerfRegistry", "tenantStatements"],
    ["corpusStatementRegistry", "corpusStatements"],
  ] as const) {
    if (
      !queryRuntime.includes(
        `export const ${exported} = (seed) => Object.values(${binding}).map((measure) => measure(seed)).toSorted((left, right) => compareCodeUnit(left.budgetId, right.budgetId));`,
      )
    ) {
      problems.push(
        `${exported}: collect measurements from entry files without inline cases`,
      );
    }
  }
  for (const directory of DB_REGISTRY_DIRECTORIES) {
    const absolute = path.join(root, directory);
    if (
      readFileSync(path.join(absolute, "registry.gen.ts"), "utf-8") !==
      renderRegistryIndex(absolute)
    ) {
      problems.push(
        `${directory}: stale index; run bun scripts/db-registry-entries.ts`,
      );
    }
    for (const name of registryEntryNames(absolute)) {
      const source = readFileSync(path.join(absolute, `${name}.ts`), "utf-8");
      if ((source.match(/\bexport default\b/gu) ?? []).length !== 1) {
        problems.push(
          `${directory}/${name}.ts: declare exactly one default entry`,
        );
      }
    }
  }
  const aggregateDirectory = path.join(root, AGGREGATE_ENTRIES);
  if (
    readFileSync(
      path.join(aggregateDirectory, "identities.gen.ts"),
      "utf-8",
    ) !== renderAggregateIdentities(aggregateDirectory)
  ) {
    problems.push(
      `${AGGREGATE_ENTRIES}: stale identity index; run bun scripts/db-registry-entries.ts`,
    );
  }
  return problems;
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  if (process.argv.includes("--check")) {
    const problems = registryLayoutProblems(root);
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) {
      process.exit(1);
    }
  } else {
    for (const directory of DB_REGISTRY_DIRECTORIES) {
      const absolute = path.join(root, directory);
      writeFileSync(
        path.join(absolute, "registry.gen.ts"),
        renderRegistryIndex(absolute),
      );
    }
    const aggregateDirectory = path.join(root, AGGREGATE_ENTRIES);
    writeFileSync(
      path.join(aggregateDirectory, "identities.gen.ts"),
      renderAggregateIdentities(aggregateDirectory),
    );
  }
}
