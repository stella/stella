import { panic, TaggedError } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  type ScopeOutput,
} from "./ci-plan-scope";
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
  guardSelectionSources,
  hasAutofixableGeneratorFailures,
  runGeneratorChecks,
  UNCHANGED_CHECKS_ENV,
  unchangedGeneratorIds,
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

test("only failures from autofix-owned generator families request autofix", () => {
  const autofixable = GENERATORS.find(
    ({ autofix, check }) => autofix && check !== null,
  );
  const protectedFamily = GENERATORS.find(
    ({ autofix, check }) => !autofix && check !== null,
  );
  if (autofixable === undefined || protectedFamily === undefined) {
    panic("Generator fixtures need both autofix-owned and protected checks");
  }
  expect(hasAutofixableGeneratorFailures([autofixable.id])).toBe(true);
  expect(hasAutofixableGeneratorFailures([protectedFamily.id])).toBe(false);
  expect(
    hasAutofixableGeneratorFailures([autofixable.id, protectedFamily.id]),
  ).toBe(true);
});

class FixtureStartFailure extends TaggedError("FixtureStartFailure")<{
  message: string;
}> {}

test("a change to the guard's own sources selects every family", () => {
  const sources = guardSelectionSources();
  for (const file of [
    "scripts/generated-files-guard.ts",
    "scripts/generated-files.ts",
    "packages/scripts/src/generated-files.ts",
  ]) {
    expect(sources.has(file), file).toBe(true);
  }
  // Only the manifest changed, for example one family's check command.
  const affected = affectedGeneratorIds(
    GENERATORS,
    ["scripts/generated-files.ts"],
    sources,
  );
  expect([...affected].toSorted()).toEqual(
    GENERATORS.map(({ id }) => id).toSorted(),
  );
  // An unrelated file still selects none.
  expect(
    affectedGeneratorIds(GENERATORS, ["docs/changelog/example.md"], sources)
      .size,
  ).toBe(0);
});

test("the census resolves a filtered workspace script and fails on an unknown command form", () => {
  const skills =
    GENERATORS.find(({ id }) => id === "skill-manifests") ??
    panic("Missing skill-manifests");
  // `bun --filter @stll/skills generate` runs packages/skills/scripts/generate-manifests.ts.
  const undeclared = {
    ...skills,
    write: ["bun", "--filter", "@stll/skills", "generate"],
    inputs: [],
    checkInputs: [],
  } satisfies Generator;
  expect(generatorInputCensus([undeclared])).toContain(
    "skill-manifests: undeclared import packages/skills/scripts/generate-manifests.ts",
  );
  // A form the census cannot resolve fails instead of contributing nothing.
  expect(() =>
    generatorInputCensus([
      { ...skills, write: ["bun", "--some-new-flag", "something"] },
    ]),
  ).toThrow("Census cannot resolve the command");
});

test("the census follows both a preload and the entry point of one Bun command", () => {
  const skills =
    GENERATORS.find(({ id }) => id === "skill-manifests") ??
    panic("Missing skill-manifests");
  const command = [
    "bun",
    "--preload",
    "scripts/offline-network-preload.ts",
    "scripts/check-mcp-generated-tracking.ts",
  ];
  const preloaded = {
    ...skills,
    write: command,
    inputs: [],
    checkInputs: [],
  } satisfies Generator;
  const failures = generatorInputCensus([preloaded]);
  expect(failures).toContain(
    "skill-manifests: undeclared import scripts/check-mcp-generated-tracking.ts",
  );
  expect(failures).toContain(
    "skill-manifests: undeclared import scripts/offline-network-preload.ts",
  );
});

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

test("the census accepts closure files in either input declaration", () => {
  const tailwind = generator("tailwind-class-cache");
  const closureFile = "scripts/generate-tailwind-classes.ts";
  const withoutClosureFile = (inputs: readonly string[]) =>
    inputs.filter((input) => !matchesGeneratedGlob(input, closureFile));
  const mutated = {
    ...tailwind,
    inputs: withoutClosureFile(tailwind.inputs),
    checkInputs: withoutClosureFile(tailwind.checkInputs ?? []),
  };
  expect(generatorInputCensus([mutated])).toContain(
    `tailwind-class-cache: undeclared import ${closureFile}`,
  );
  expect(
    generatorInputCensus([
      { ...mutated, checkInputs: [closureFile, ...mutated.checkInputs] },
    ]),
  ).not.toContain(`tailwind-class-cache: undeclared import ${closureFile}`);
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
const exited = (exit: number) => ({ exit, peakMiB: 0 });

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
      return exited(1);
    }
    if (entry.id === "cloud-setup") {
      throw new FixtureStartFailure({
        message: "fixture process could not start",
      });
    }
    return exited(0);
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
    return exited(0);
  });
  expect(failures).toEqual([]);
  expect(peak).toBe(2);
});

test("every checked family remains a failure when its check reports a violation", async () => {
  const failures = await runGeneratorChecks(GENERATORS, async () => exited(1));
  expect(failures).toEqual(
    GENERATORS.filter(({ check }) => check !== null).map(({ id }) => ({
      id,
      failure: "exit 1",
    })),
  );
});

test("names each check whose peak RSS exceeds its reservation", async () => {
  const peaks = new Map([
    ["cloud-setup", 1025],
    ["bun-toolchain", 1024],
    ["schema-index", 2048],
    ["failure-tags", 2049],
  ]);
  const checks = [...peaks.keys()].map(generator);
  const failures = await runGeneratorChecks(checks, async ({ id }) => ({
    exit: id === "failure-tags" ? 1 : 0,
    peakMiB: peaks.get(id) ?? panic(`No peak for ${id}`),
  }));
  expect(failures).toEqual([
    {
      id: "cloud-setup",
      failure: "peak RSS 1025 MiB exceeds its 1024 MiB reservation",
    },
    {
      id: "failure-tags",
      failure: "exit 1; peak RSS 2049 MiB exceeds its 2048 MiB reservation",
    },
  ]);
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
      return exited(1);
    }
    return exited(0);
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
      exited(await generateBunToolchain(path.join(root, id), false));
    const sequential: { id: string; failure: string }[] = [];
    for (const entry of checks) {
      const { exit } = await check(entry);
      if (exit !== 0) {
        sequential.push({ id: entry.id, failure: `exit ${exit}` });
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

type DelegationCase = {
  readonly guardCondition: string;
  readonly delegation: string;
  /** Each delegable family's owning job condition. */
  readonly ownerConditions: ReadonlyMap<string, string>;
};

// In every run the guard job takes, a family is handed off exactly when its
// owning job runs (sound and complete), and each family is handed off in some
// run. Stops at the first violating run so a broken binding fails fast.
const delegationViolations = ({
  guardCondition,
  delegation,
  ownerConditions,
}: DelegationCase): string[] => {
  const violations: string[] = [];
  const delegatedSomewhere = new Set<string>();
  // A handful of distinct values across all runs; parse each once.
  const parsed = new Map<string, ReadonlySet<string>>();
  for (const context of contexts([
    guardCondition,
    delegation,
    ...ownerConditions.values(),
  ])) {
    if (evaluate(guardCondition, context) !== true) {
      continue;
    }
    const value = evaluate(delegation, context);
    if (typeof value !== "string") {
      return [`${DELEGATED_CHECKS_ENV} is not a string`];
    }
    const delegated = parsed.get(value) ?? delegatedGeneratorIds(value);
    parsed.set(value, delegated);
    for (const id of delegated) {
      delegatedSomewhere.add(id);
      if (!ownerConditions.has(id)) {
        violations.push(`${id} is delegated without an owning job`);
      }
    }
    for (const [id, condition] of ownerConditions) {
      const ownerRuns = evaluate(condition, context) === true;
      if (delegated.has(id) !== ownerRuns) {
        violations.push(
          `${id} ${ownerRuns ? "is checked twice" : "is delegated to an owner that does not run"} in ${JSON.stringify(context.values)}`,
        );
      }
    }
    if (violations.length > 0) {
      return violations;
    }
  }
  for (const id of ownerConditions.keys()) {
    if (!delegatedSomewhere.has(id)) {
      violations.push(`${id} is never delegated`);
    }
  }
  return violations;
};

test("the delegation check rejects unsound, incomplete and dead hand-offs", () => {
  const wasm = "needs.ci-plan.outputs.wasm == 'true'";
  const typecheck = "github.event_name == 'merge_group'";
  const binding = (first: string, second: string) =>
    `format('["{0}","{1}"]', ${first} && 'scan-engine-wasm' || '', ${second} && 'api-typecheck-projects' || '')`;
  const ownerConditions = new Map([
    ["scan-engine-wasm", wasm],
    ["api-typecheck-projects", typecheck],
  ]);
  const guardCondition = "github.event_name != 'push'";
  expect(
    delegationViolations({
      guardCondition,
      delegation: binding(wasm, typecheck),
      ownerConditions,
    }),
  ).toEqual([]);
  // Handed off in a run whose owner does not run: nobody checks it.
  expect(
    delegationViolations({
      guardCondition,
      delegation: binding("true", typecheck),
      ownerConditions,
    }).at(0),
  ).toContain("scan-engine-wasm is delegated to an owner that does not run");
  // Kept although its owner runs: the check runs twice.
  expect(
    delegationViolations({
      guardCondition,
      delegation: binding(wasm, "false"),
      ownerConditions,
    }).at(0),
  ).toContain("api-typecheck-projects is checked twice");
  // An owner that never runs where the guard does leaves a dead entry.
  expect(
    delegationViolations({
      guardCondition,
      delegation: binding(wasm, "false"),
      ownerConditions: new Map([
        ["scan-engine-wasm", wasm],
        ["api-typecheck-projects", "false"],
      ]),
    }),
  ).toEqual(["api-typecheck-projects is never delegated"]);
});

test("Guard B delegates each check exactly in runs whose owning job runs it", () => {
  const step = namedJobStep(GUARD_JOB, "Generated files manifest guard");
  const env = step?.["env"];
  const delegation = isRecord(env) ? env[DELEGATED_CHECKS_ENV] : undefined;
  if (typeof delegation !== "string") {
    panic(`Guard B step has no ${DELEGATED_CHECKS_ENV}`);
  }
  // Each family's owning job, resolved once: the job that runs its
  // `checkedBy` step unconditionally and that ci-result gates.
  const ownerConditions = new Map(
    DELEGABLE.map((id) => {
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
        return panic(
          `${id} needs exactly one owning job: ${owners.join(", ")}`,
        );
      }
      expect(namedJobStep(owner, checkedBy ?? "")?.["if"], id).toBeUndefined();
      const ciResult = workflowJobs()["ci-result"];
      const gated = isRecord(ciResult) ? ciResult["needs"] : undefined;
      expect(Array.isArray(gated) && gated.includes(owner), owner).toBe(true);
      return [id, jobCondition(owner)] as const;
    }),
  );
  expect(
    delegationViolations({
      guardCondition: jobCondition(GUARD_JOB),
      delegation,
      ownerConditions,
    }),
  ).toEqual([]);
});

test("rejects unchanged checks that no CI step proves", () => {
  expect(unchangedGeneratorIds(undefined)).toEqual(new Set());
  expect(unchangedGeneratorIds('[""]')).toEqual(new Set());
  expect(unchangedGeneratorIds('["scan-engine-wasm"]')).toEqual(
    new Set(["scan-engine-wasm"]),
  );
  expect(() => unchangedGeneratorIds("scan-engine-wasm")).toThrow(
    "must be a JSON array of generator ids",
  );
  for (const value of ['["missing-generator"]', '["scan-engine-fixtures"]']) {
    expect(() => unchangedGeneratorIds(value), value).toThrow(
      "has no owning CI step to prove its outputs",
    );
  }
});

// Every family Guard B may skip as unchanged, with the plan output that is
// "false" exactly when no path of the family changed.
const UNCHANGED_SCOPES = new Map<string, ScopeOutput>([
  ["scan-engine-wasm", "scan_engine_wasm_required"],
]);

test("Guard B skips a family as unchanged only when the plan proves it untouched", () => {
  const step = namedJobStep(GUARD_JOB, "Generated files manifest guard");
  const env = step?.["env"];
  const unchanged = isRecord(env) ? env[UNCHANGED_CHECKS_ENV] : undefined;
  if (typeof unchanged !== "string") {
    panic(`Guard B step has no ${UNCHANGED_CHECKS_ENV}`);
  }
  const guardCondition = jobCondition(GUARD_JOB);
  const named = new Set<string>();
  for (const context of contexts([guardCondition, unchanged])) {
    if (evaluate(guardCondition, context) !== true) {
      continue;
    }
    const value = evaluate(unchanged, context);
    if (typeof value !== "string") {
      panic(`${UNCHANGED_CHECKS_ENV} is not a string`);
    }
    for (const id of unchangedGeneratorIds(value)) {
      const scope =
        UNCHANGED_SCOPES.get(id) ?? panic(`${id} has no plan output`);
      // Sound: an empty or missing plan output never skips a check.
      expect(context.values[`needs.ci-plan.outputs.${scope}`], id).toBe(
        "false",
      );
      named.add(id);
    }
  }
  expect([...named].toSorted()).toEqual(
    [...UNCHANGED_SCOPES.keys()].toSorted(),
  );
});

test("each unchanged plan output covers its family's inputs, outputs and check", () => {
  const scoped = (file: string, output: ScopeOutput) =>
    computeChangedFileScope(
      {
        changedFiles: [file],
        comparisonBase: "base",
        scopeUnknown: false,
        eventName: "pull_request",
        suiteDepth: "fast",
        heavyOnly: false,
        prTitle: "",
      },
      {
        ...DEFAULT_DETECTORS,
        packageChecks: () => true,
        landingBuild: () => false,
        landingDeploy: () => false,
        desktopBrowser: () => false,
      },
    )[output];
  for (const [id, output] of UNCHANGED_SCOPES) {
    const family = checkedGenerator(id);
    const scripts = family.check.filter((part) => /\.(?:sh|ts)$/u.test(part));
    expect(scripts.length, id).toBeGreaterThan(0);
    for (const glob of [...family.inputs, ...family.outputs, ...scripts]) {
      // Plan patterns are shell case patterns, so * crosses directories.
      const sample = glob
        .replace(/\*\*/gu, "nested/fixture")
        .replace(/\*/gu, "fixture");
      expect(scoped(sample, output), `${output} covers ${glob}`).toBe("true");
    }
  }
});
