import { panic, TaggedError } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateBunToolchain } from "./generate-bun-toolchain";
import {
  type Generator,
  GENERATORS,
  matchesGeneratedGlob,
} from "./generated-files";
import {
  affectedGeneratorIds,
  changedSince,
  DELEGATED_CHECKS_ENV,
  delegatedGeneratorIds,
  generatorInputCensus,
  runGeneratorChecks,
  undeclaredInputFailure,
} from "./generated-files-guard";
import { type Context, evaluate } from "./github-expression";
import { workflowJobSteps } from "./workflow-steps";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const generator = (id: string) =>
  GENERATORS.find((entry) => entry.id === id) ??
  panic(`Missing generator ${id}`);

const checkedGenerator = (id: string) => {
  const entry = generator(id);
  if (entry.check === null) {
    panic(`Fixture needs a checked generator: ${id}`);
  }
  return entry;
};

class FixtureStartFailure extends TaggedError("FixtureStartFailure")<{
  message: string;
}> {}

test("selects direct, output, and transitive changes while unrelated files select none", () => {
  const direct = affectedGeneratorIds(GENERATORS, [
    "apps/web/src/components/example.tsx",
  ]);
  expect(direct.has("tailwind-class-cache")).toBe(true);
  const output = affectedGeneratorIds(GENERATORS, [
    "scripts/bun-toolchain.gen.json",
  ]);
  expect(output.has("bun-toolchain")).toBe(true);
  const transitive = affectedGeneratorIds(GENERATORS, [
    "apps/api/src/mcp/example.ts",
  ]);
  expect(transitive.has("cli-registry")).toBe(true);
  expect(
    affectedGeneratorIds(GENERATORS, ["docs/changelog/example.md"]).size,
  ).toBe(0);
  expect(affectedGeneratorIds(GENERATORS, null).size).toBe(GENERATORS.length);
});

test("a glob that matches nothing leaves every family unaffected", () => {
  const fixture = [
    { ...generator("bun-toolchain"), inputs: ["missing/**/*.ts"] },
  ] satisfies Generator[];
  expect(affectedGeneratorIds(fixture, ["docs/other.md"])).toEqual(new Set());
});

test("a check-only input change selects its generator family", () => {
  const fixture = [
    {
      ...generator("bun-toolchain"),
      checkInputs: ["scripts/check-only.ts"],
    },
  ] satisfies Generator[];
  expect(affectedGeneratorIds(fixture, ["scripts/check-only.ts"])).toEqual(
    new Set(["bun-toolchain"]),
  );
});

test("a renamed input reports both the removed and destination paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generator-rename-"));
  const runGit = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  try {
    expect(runGit(["init", "-q"]).exitCode).toBe(0);
    expect(runGit(["config", "user.email", "test@example.com"]).exitCode).toBe(
      0,
    );
    expect(runGit(["config", "user.name", "Test"]).exitCode).toBe(0);
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts/generate-bun-toolchain.ts"), "x");
    expect(runGit(["add", "."]).exitCode).toBe(0);
    expect(runGit(["commit", "-qm", "fixture"]).exitCode).toBe(0);
    const base = runGit(["rev-parse", "HEAD"]).stdout.toString().trim();
    await mkdir(path.join(root, "docs"));
    await rename(
      path.join(root, "scripts/generate-bun-toolchain.ts"),
      path.join(root, "docs/unrelated.md"),
    );
    expect(runGit(["add", "-A"]).exitCode).toBe(0);
    expect(runGit(["commit", "-qm", "move input"]).exitCode).toBe(0);

    const changed = changedSince(base, root);
    expect(changed).toContain("scripts/generate-bun-toolchain.ts");
    expect(changed).toContain("docs/unrelated.md");
    expect(affectedGeneratorIds(GENERATORS, changed)).toContain(
      "bun-toolchain",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("formatter configuration changes select formatter-backed families", () => {
  const affected = affectedGeneratorIds(GENERATORS, ["bunfig.toml"]);
  for (const id of ["failure-tags", "status-tables", "account-export-tables"]) {
    expect(affected.has(id), id).toBe(true);
  }
});

test("the census rejects a removed Tailwind closure module", () => {
  const tailwind = generator("tailwind-class-cache");
  const mutated = {
    ...tailwind,
    inputs: tailwind.inputs.filter(
      (input) =>
        !matchesGeneratedGlob(input, "scripts/generate-tailwind-classes.ts"),
    ),
  };
  expect(generatorInputCensus([mutated])).toContain(
    "tailwind-class-cache: undeclared import scripts/generate-tailwind-classes.ts",
  );
});

test("the census rejects a write closure file declared only as a check input", () => {
  const tailwind = generator("tailwind-class-cache");
  const writeInput = "scripts/generate-tailwind-classes.ts";
  const mutated = {
    ...tailwind,
    inputs: tailwind.inputs.filter(
      (input) => !matchesGeneratedGlob(input, writeInput),
    ),
    checkInputs: [...(tailwind.checkInputs ?? []), writeInput],
  };
  expect(generatorInputCensus([mutated])).toContain(
    `tailwind-class-cache: undeclared import ${writeInput}`,
  );
});

test("full runs reject diffs from families unchanged since HEAD~1", () => {
  expect(
    undeclaredInputFailure(
      generator("bun-toolchain"),
      ["docs/changelog/x.md"],
      ["scripts/bun-toolchain.gen.json"],
    ),
  ).toContain("bun-toolchain");
  expect(
    undeclaredInputFailure(
      generator("bun-toolchain"),
      ["package.json"],
      ["scripts/bun-toolchain.gen.json"],
    ),
  ).toBeUndefined();
});

test("runs every manifest check exactly once and continues after failed and rejected checks", async () => {
  const visited: string[] = [];
  const completed = new Set<string>();
  const failures = await runGeneratorChecks(GENERATORS, async (entry) => {
    for (const dependency of entry.after) {
      const predecessor = generator(dependency);
      if (predecessor.check !== null) {
        expect(completed.has(dependency)).toBe(true);
      }
    }
    visited.push(entry.id);
    await Promise.resolve();
    completed.add(entry.id);
    if (entry.id === "bun-toolchain") {
      return 1;
    }
    if (entry.id === "cloud-setup") {
      throw new FixtureStartFailure({
        message: "fixture process could not start",
      });
    }
    return 0;
  });
  const checked = GENERATORS.filter(({ check }) => check !== null).map(
    ({ id }) => id,
  );
  expect(visited.toSorted()).toEqual(checked.toSorted());
  expect(new Set(visited).size).toBe(checked.length);
  expect(failures.map(({ id }) => id).toSorted()).toEqual([
    "bun-toolchain",
    "cloud-setup",
  ]);
});

test("overlaps at most two audited checks and keeps new or changed commands exclusive", async () => {
  const checks = [
    generator("cloud-setup"),
    generator("bun-toolchain"),
    {
      ...checkedGenerator("bun-toolchain"),
      id: "new-command",
      check: ["bun", "different-generator.ts"],
    },
    generator("i18n-messages-landing"),
    generator("schema-index"),
  ] satisfies Generator[];
  const exclusive = new Set(["new-command", "schema-index"]);
  const active = new Set<string>();
  let peak = 0;
  const failures = await runGeneratorChecks(checks, async ({ id }) => {
    if (exclusive.has(id)) {
      expect(active.size).toBe(0);
    } else {
      expect([...active].some((running) => exclusive.has(running))).toBe(false);
    }
    active.add(id);
    peak = Math.max(peak, active.size);
    expect(active.size).toBeLessThanOrEqual(2);
    await Promise.resolve();
    active.delete(id);
    return 0;
  });
  expect(failures).toEqual([]);
  expect(peak).toBe(2);
});

test("every checked family remains a failure when its check reports a violation", async () => {
  const failures = await runGeneratorChecks(GENERATORS, async () => 1);
  expect(failures).toEqual(
    GENERATORS.filter(({ check }) => check !== null).map(({ id }) => ({
      id,
      failure: "exit 1",
    })),
  );
});

test("preserves dependency barriers through unchecked families even after upstream failure", async () => {
  const upstream = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const visited: string[] = [];
  const checks = [
    { ...generator("bun-toolchain"), id: "upstream", after: [] },
    { ...generator("cli-runtime"), id: "unchecked", after: ["upstream"] },
    { ...generator("cloud-setup"), id: "downstream", after: ["unchecked"] },
  ] satisfies Generator[];
  const result = runGeneratorChecks(checks, async ({ id }) => {
    visited.push(id);
    if (id === "upstream") {
      started.resolve(undefined);
      await upstream.promise;
      return 1;
    }
    return 0;
  });
  await started.promise;
  expect(visited).toEqual(["upstream"]);
  upstream.resolve(undefined);
  expect(await result).toEqual([{ id: "upstream", failure: "exit 1" }]);
  expect(visited).toEqual(["upstream", "downstream"]);
});

test("matches sequential generator findings including stale and missing committed outputs", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "generator-check-equivalence-"),
  );
  try {
    const fixtures = ["valid", "stale", "missing"] as const;
    for (const fixture of fixtures) {
      const directory = path.join(root, fixture);
      await mkdir(path.join(directory, "scripts"), { recursive: true });
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ packageManager: "bun@1.4.3" }),
      );
      if (fixture !== "missing") {
        await writeFile(
          path.join(directory, "scripts/bun-toolchain.gen.json"),
          `${JSON.stringify({ packageManager: fixture === "stale" ? "bun@0.0.1" : "bun@1.4.3" }, null, 2)}\n`,
        );
      }
    }
    const checks = fixtures.map((id) => ({
      ...generator("bun-toolchain"),
      id,
    }));
    const check = async ({ id }: Generator) =>
      generateBunToolchain(path.join(root, id), false);
    const sequential: { id: string; failure: string }[] = [];
    for (const entry of checks) {
      const code = await check(entry);
      if (code !== 0) {
        sequential.push({ id: entry.id, failure: `exit ${code}` });
      }
    }
    expect(sequential).toEqual([
      { id: "stale", failure: "exit 1" },
      { id: "missing", failure: "exit 1" },
    ]);
    expect(await runGeneratorChecks(checks, check)).toEqual(sequential);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const WORKFLOW: unknown = Bun.YAML.parse(
  await Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text(),
);
const GUARD_JOB = "ci-checks-rest";

const workflowJobs = () => {
  if (!isRecord(WORKFLOW) || !isRecord(WORKFLOW["jobs"])) {
    return panic("ci.yml has no jobs");
  }
  return WORKFLOW["jobs"];
};

const jobCondition = (job: string) => {
  const definition = workflowJobs()[job];
  if (!isRecord(definition) || typeof definition["if"] !== "string") {
    return panic(`${job} has no if: condition`);
  }
  return definition["if"];
};

const namedJobStep = (job: string, name: string) =>
  workflowJobSteps(WORKFLOW, job).find((step) => step["name"] === name);

// Every value each condition can branch on, so the binding is exhaustive.
const contexts = (sources: readonly string[]): Context[] => {
  const paths = [
    ...new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/\b(?:github|inputs|needs)\.[\w.-]+/gu)].map(
          ([contextPath]) => contextPath,
        ),
      ),
    ),
  ].toSorted();
  const domain = (contextPath: string): readonly (string | boolean)[] => {
    if (contextPath === "github.event_name") {
      return ["pull_request", "merge_group", "workflow_dispatch", "push"];
    }
    if (contextPath.startsWith("inputs.")) {
      return [false, true];
    }
    // A needed job either succeeded or did not; every other result compares
    // the same as a skip.
    if (/^needs\.[\w-]+\.result$/u.test(contextPath)) {
      return ["success", "skipped"];
    }
    return ["true", "false", ""];
  };
  // The run itself is live, so status checks such as `!cancelled()` resolve.
  const status = {
    always: true,
    success: true,
    failure: false,
    cancelled: false,
  };
  let expanded: Context[] = [{ values: {}, status }];
  for (const contextPath of paths) {
    expanded = expanded.flatMap((context) =>
      domain(contextPath).map((value) => ({
        values: { ...context.values, [contextPath]: value },
        status,
      })),
    );
  }
  return expanded;
};

test("rejects delegated checks that no other CI step runs", () => {
  expect(delegatedGeneratorIds(undefined)).toEqual(new Set());
  expect(delegatedGeneratorIds('["scan-engine-wasm"]')).toEqual(
    new Set(["scan-engine-wasm"]),
  );
  // Entries whose condition did not hold are empty and name nothing.
  expect(delegatedGeneratorIds('["",""]')).toEqual(new Set());
  expect(delegatedGeneratorIds('["","api-typecheck-projects"]')).toEqual(
    new Set(["api-typecheck-projects"]),
  );
  for (const value of [
    "",
    "scan-engine-wasm",
    '{"id":"scan-engine-wasm"}',
    "[1]",
  ]) {
    expect(() => delegatedGeneratorIds(value), value).toThrow(
      "must be a JSON array of generator ids",
    );
  }
  // Checked only by Guard B, or unknown: nothing else would run it.
  for (const value of ['["missing-generator"]', '["scan-engine-fixtures"]']) {
    expect(() => delegatedGeneratorIds(value), value).toThrow(
      "has no check delegated to another CI step",
    );
  }
});

// Every family Guard B may hand to another job, each exactly in the runs whose
// owning job runs its `checkedBy` step.
const DELEGABLE = ["scan-engine-wasm", "api-typecheck-projects"] as const;

// timeout: exhaustively evaluates every Boolean CI context combination.
test("Guard B delegates each check exactly in runs whose owning job runs it", () => {
  const step = namedJobStep(GUARD_JOB, "Generated files manifest guard");
  const env = step?.["env"];
  const delegation = isRecord(env) ? env[DELEGATED_CHECKS_ENV] : undefined;
  if (typeof delegation !== "string") {
    panic(`Guard B step has no ${DELEGATED_CHECKS_ENV}`);
  }
  const ownerOf = (id: string) => {
    const { checkedBy } = generator(id);
    const owners = Object.entries(workflowJobs()).flatMap(
      ([job, definition]) =>
        job !== GUARD_JOB &&
        isRecord(definition) &&
        "steps" in definition &&
        checkedBy !== undefined &&
        namedJobStep(job, checkedBy) !== undefined
          ? [job]
          : [],
    );
    const [owner] = owners;
    if (owner === undefined || owners.length > 1) {
      return panic(`${id} needs exactly one owning job: ${owners.join(", ")}`);
    }
    // The owning step runs whenever its job does, and ci-result gates it.
    expect(namedJobStep(owner, checkedBy ?? "")?.["if"], id).toBeUndefined();
    const ciResult = workflowJobs()["ci-result"];
    const gated = isRecord(ciResult) ? ciResult["needs"] : undefined;
    expect(Array.isArray(gated) && gated.includes(owner), owner).toBe(true);
    return owner;
  };
  const owners = new Map(DELEGABLE.map((id) => [id, ownerOf(id)]));
  const guardCondition = jobCondition(GUARD_JOB);
  const sources = [
    guardCondition,
    delegation,
    ...[...owners.values()].map(jobCondition),
  ];
  const outcomes = new Set<string>();
  for (const context of contexts(sources)) {
    if (evaluate(guardCondition, context) !== true) {
      continue;
    }
    const value = evaluate(delegation, context);
    if (typeof value !== "string") {
      panic(`${DELEGATED_CHECKS_ENV} is not a string`);
    }
    const delegated = delegatedGeneratorIds(value);
    for (const id of delegated) {
      // Sound: a skipped family is built by its owner in this same run.
      expect(evaluate(jobCondition(ownerOf(id)), context), id).toBe(true);
    }
    // Complete: no run performs a delegable check in both jobs.
    for (const [id, owner] of owners) {
      expect(delegated.has(id), id).toBe(
        evaluate(jobCondition(owner), context) === true,
      );
    }
    outcomes.add([...delegated].toSorted().join(","));
  }
  // Each entry delegates in some run, so none is dead text.
  for (const id of DELEGABLE) {
    expect(
      [...outcomes].some((outcome) => outcome.includes(id)),
      id,
    ).toBe(true);
  }
}, 10_000);
