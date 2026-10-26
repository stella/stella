import { panic, TaggedError } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  type ScopeOutput,
} from "./ci-plan-scope";
import { generateBunToolchain } from "./generate-bun-toolchain";
import { type Generator, GENERATORS } from "./generated-files";
import {
  DELEGATED_CHECKS_ENV,
  delegatedGeneratorIds,
  hasAutofixableGeneratorFailures,
  runGeneratorChecks,
  UNCHANGED_CHECKS_ENV,
  unchangedGeneratorIds,
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
