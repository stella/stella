import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DB_REGISTRY_DIRECTORIES,
  registryEntryNames,
  registryLayoutProblems,
  renderAggregateIdentities,
  renderRegistryIndex,
} from "./db-registry-entries";

const root = path.resolve(import.meta.dir, "..");
const temporaryRepository = () =>
  mkdtempSync(path.join(tmpdir(), "db-registry-entries-"));
const runGit = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "core.attributesFile=/dev/null", ...args], {
    maxBuffer: 2 ** 30,
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
    },
  });
const git = (cwd: string, args: string[]) => {
  const result = runGit(cwd, args);
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
};
const writeEntry = (directory: string, name: string, value: number) => {
  writeFileSync(
    path.join(directory, `${name}.ts`),
    `export default { value: ${value} } as const;\nexport type Identity = { value: number };\n`,
  );
  writeFileSync(
    path.join(directory, "registry.gen.ts"),
    renderRegistryIndex(directory),
  );
  if (path.basename(directory) === "aggregate-lock-entries") {
    writeFileSync(
      path.join(directory, "identities.gen.ts"),
      renderAggregateIdentities(directory),
    );
  }
};

type MergeScenario = {
  operation: "add" | "bump";
  placement: "separated" | "adjacent";
};
const BASE_ENTRY_NAMES = ["d", "h", "l", "p", "t", "x"];
const buildBranches = ({ operation, placement }: MergeScenario) => {
  const cwd = temporaryRepository();
  git(cwd, ["init", "--initial-branch=base"]);
  git(cwd, ["config", "user.email", "registry@example.test"]);
  git(cwd, ["config", "user.name", "Registry test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  for (const relative of DB_REGISTRY_DIRECTORIES) {
    const directory = path.join(cwd, relative);
    mkdirSync(directory, { recursive: true });
    for (const name of BASE_ENTRY_NAMES) {
      writeEntry(directory, name, 1);
    }
  }
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "base"]);
  let left = placement === "separated" ? "a" : "y";
  let right = "z";
  if (operation === "bump") {
    left = "d";
    right = "x";
  }
  for (const [branch, name] of [
    ["left", left],
    ["right", right],
  ] as const) {
    git(cwd, ["switch", "-c", branch, "base"]);
    for (const relative of DB_REGISTRY_DIRECTORIES) {
      writeEntry(path.join(cwd, relative), name, 2);
    }
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", branch]);
  }
  return { cwd, left, right };
};

describe("independent database registry entries", () => {
  test("tracked projections are fresh and entry files have one owner", () => {
    expect(registryLayoutProblems(root)).toEqual([]);
    for (const relative of DB_REGISTRY_DIRECTORIES) {
      const names = registryEntryNames(path.join(root, relative));
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(names.toSorted());
    }
  });

  for (const scenario of [
    { operation: "add", placement: "separated", expectedStatus: 1 },
    { operation: "bump", placement: "separated", expectedStatus: 0 },
    { operation: "add", placement: "adjacent", expectedStatus: 1 },
  ] as const) {
    test(`${scenario.placement} ${scenario.operation} changes retain both entries after merging or regeneration without attributes`, async () => {
      const { cwd, left, right } = buildBranches(scenario);
      try {
        const result = runGit(cwd, [
          "merge-tree",
          "--write-tree",
          "left",
          "right",
        ]);
        expect(result.status, result.stderr + result.stdout).toBe(
          scenario.expectedStatus,
        );
        const tree = result.stdout.split("\n").at(0);
        if (tree === undefined || !/^[0-9a-f]+$/u.test(tree)) {
          throw new TypeError("merge-tree must return a merged tree");
        }
        git(cwd, ["read-tree", "--reset", "-u", tree]);
        for (const relative of DB_REGISTRY_DIRECTORIES) {
          const directory = path.join(cwd, relative);
          const index = path.join(directory, "registry.gen.ts");
          if (scenario.expectedStatus === 1) {
            expect(result.stdout).toContain(
              `CONFLICT (content): Merge conflict in ${relative}/registry.gen.ts`,
            );
            const conflicted = readFileSync(index, "utf-8");
            expect(conflicted).toContain("<<<<<<<");
            expect(conflicted).not.toBe(renderRegistryIndex(directory));
            // Entry modules survive the merge. Only the generator resolves its projection.
            writeFileSync(index, renderRegistryIndex(directory));
            if (path.basename(directory) === "aggregate-lock-entries") {
              const identities = path.join(directory, "identities.gen.ts");
              if (readFileSync(identities, "utf-8").includes("<<<<<<<")) {
                writeFileSync(identities, renderAggregateIdentities(directory));
              }
            }
          }
          expect(readFileSync(index, "utf-8")).toBe(
            renderRegistryIndex(directory),
          );
          const module: unknown = await import(pathToFileURL(index).href);
          if (typeof module !== "object" || module === null) {
            throw new TypeError("Merged registry must load as a module object");
          }
          const merged: unknown = Reflect.get(module, "default");
          if (typeof merged !== "object" || merged === null) {
            throw new TypeError("Merged registry must have a default map");
          }
          const expectedKeys =
            scenario.operation === "add"
              ? [...BASE_ENTRY_NAMES, left, right].toSorted()
              : BASE_ENTRY_NAMES;
          expect(Object.keys(merged).toSorted()).toEqual(expectedKeys);
          expect(Reflect.get(merged, left)).toEqual({ value: 2 });
          expect(Reflect.get(merged, right)).toEqual({ value: 2 });
          expect(registryEntryNames(directory)).toEqual(expectedKeys);
          if (path.basename(directory) === "aggregate-lock-entries") {
            expect(
              readFileSync(path.join(directory, "identities.gen.ts"), "utf-8"),
            ).toBe(renderAggregateIdentities(directory));
          }
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  test("a legitimate new read budget loads without changing a fixture", async () => {
    const directory = temporaryRepository();
    try {
      writeEntry(directory, "first", 1);
      const before = renderRegistryIndex(directory);
      writeFileSync(
        path.join(directory, "statement.example.search.ts"),
        'export default { surface: "statement", pages: 16, reason: "One bounded example lookup." } as const;\n',
      );
      const after = renderRegistryIndex(directory);
      writeFileSync(path.join(directory, "registry.gen.ts"), after);
      expect(after).not.toBe(before);
      expect(
        readFileSync(path.join(directory, "registry.gen.ts"), "utf-8"),
      ).toBe(after);
      const module: unknown = await import(
        pathToFileURL(path.join(directory, "registry.gen.ts")).href
      );
      if (typeof module !== "object" || module === null) {
        throw new TypeError("New budget must load as a module object");
      }
      const registry: unknown = Reflect.get(module, "default");
      if (typeof registry !== "object" || registry === null) {
        throw new TypeError("Generated registry must have a default map");
      }
      expect(Reflect.get(registry, "statement.example.search")).toEqual({
        surface: "statement",
        pages: 16,
        reason: "One bounded example lookup.",
      });
      expect(registryEntryNames(directory)).toEqual([
        "first",
        "statement.example.search",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("value changes leave the generated membership index unchanged", () => {
    const directory = temporaryRepository();
    try {
      writeEntry(directory, "first", 1);
      const before = renderRegistryIndex(directory);
      writeEntry(directory, "first", 2);
      expect(renderRegistryIndex(directory)).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("inline entries in the old registry layout are refused", () => {
    const cwd = temporaryRepository();
    try {
      for (const relative of DB_REGISTRY_DIRECTORIES) {
        cpSync(path.join(root, relative), path.join(cwd, relative), {
          recursive: true,
        });
      }
      const facades = [
        "apps/api/src/lib/db/aggregate-lock.ts",
        "apps/api/src/lib/db/read-budgets.ts",
        "apps/api/src/tests/query-perf/registry.ts",
        "apps/api/src/tests/query-perf/owner-deadlines.ts",
      ];
      for (const file of facades) {
        cpSync(path.join(root, file), path.join(cwd, file));
      }
      expect(registryLayoutProblems(cwd)).toEqual([]);
      for (const [file, binding, exported] of [
        [
          "apps/api/src/lib/db/aggregate-lock.ts",
          "aggregateLocks",
          "AGGREGATE_LOCKS",
        ],
        [
          "apps/api/src/lib/db/aggregate-lock.ts",
          "aggregateChains",
          "AGGREGATE_CHAINS",
        ],
        ["apps/api/src/lib/db/read-budgets.ts", "readBudgets", "READ_BUDGETS"],
        [
          "apps/api/src/lib/db/read-budgets.ts",
          "mcpToolReadBudgets",
          "MCP_TOOL_READ_BUDGETS",
        ],
        [
          "apps/api/src/tests/query-perf/registry.ts",
          "readBudgetProfiles",
          "READ_BUDGET_PROFILES",
        ],
        [
          "apps/api/src/tests/query-perf/registry.ts",
          "scheduledJobMeasurements",
          "SCHEDULED_JOB_MEASUREMENTS",
        ],
        [
          "apps/api/src/tests/query-perf/owner-deadlines.ts",
          "deadlines",
          "QUERY_PERF_OWNER_DEADLINES",
        ],
      ] as const) {
        const original = readFileSync(path.join(cwd, file), "utf-8");
        const inline = original
          .replace(`= ${binding}`, () => `= { ...${binding}, addedInline: {} }`)
          .replace(`...${binding} }`, () => `...${binding}, addedInline: {} }`);
        expect(inline).not.toBe(original);
        writeFileSync(path.join(cwd, file), inline);
        expect(
          registryLayoutProblems(cwd).some((problem) =>
            problem.startsWith(exported),
          ),
        ).toBe(true);
        writeFileSync(path.join(cwd, file), original);
      }
      const queryFacade = "apps/api/src/tests/query-perf/registry.ts";
      for (const binding of ["tenantStatements", "corpusStatements"]) {
        const original = readFileSync(path.join(cwd, queryFacade), "utf-8");
        const inline = original.replace(
          `Object.values(${binding})`,
          () => `Object.values({ ...${binding}, addedInline: () => ({}) })`,
        );
        expect(inline).not.toBe(original);
        writeFileSync(path.join(cwd, queryFacade), inline);
        expect(
          registryLayoutProblems(cwd).some((problem) =>
            problem.includes("without inline cases"),
          ),
        ).toBe(true);
        writeFileSync(path.join(cwd, queryFacade), original);
      }
      for (const file of facades) {
        const original = readFileSync(path.join(cwd, file), "utf-8");
        const inline = original.replace(
          /import (\w+) from "[^"\n]+\/registry.gen";/u,
          "const $1 = { addedInline: {} };",
        );
        expect(inline).not.toBe(original);
        writeFileSync(path.join(cwd, file), inline);
        expect(
          registryLayoutProblems(cwd).some((problem) =>
            problem.startsWith(file),
          ),
        ).toBe(true);
        writeFileSync(path.join(cwd, file), original);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
