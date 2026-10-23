import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { allApiTests } from "./api-test-impact";
import { FULL_TEST_JOB_SHARDS } from "./api-test-shard-plan";
import { selectedTestJobs } from "./ci-affected-selection";
import { parseApiTestImpact, planCiApiTests } from "./ci-api-test-plan";

const selected = () => ({
  mode: "selected" as const,
  files: ["src/a.test.ts", "src/b.test.ts"],
  shards: 2,
});

const matrixShards = (plan: ReturnType<typeof planCiApiTests>) => {
  expect(plan.type).toBe("run");
  if (plan.type !== "run") {
    throw new TypeError("Expected API test plan to run");
  }
  return plan.matrix.shard;
};

test("pull requests omit idle API runners and keep the shared rest/web runner", () => {
  const plan = planCiApiTests({
    event: "pull_request",
    scopeUnknown: false,
    testJobs: ["rest-web"],
    select: () => {
      throw new Error("selector should not run");
    },
  });
  expect(matrixShards(plan)).toEqual(["rest-web"]);
  expect(plan.impact.mode).toBe("none");
  expect(
    matrixShards(
      planCiApiTests({
        event: "pull_request",
        scopeUnknown: false,
        testJobs: FULL_TEST_JOB_SHARDS,
        select: () => ({ mode: "none", files: [], shards: 0 }),
      }),
    ),
  ).toEqual(["rest-web"]);
  expect(
    matrixShards(
      planCiApiTests({
        event: "pull_request",
        scopeUnknown: false,
        testJobs: FULL_TEST_JOB_SHARDS,
        select: selected,
      }),
    ),
  ).toEqual(["api-1", "api-2", "rest-web"]);
});

test("dispatches and unreadable scopes retain every API shard without invoking the selector", () => {
  for (const [event, scopeUnknown] of [
    ["workflow_dispatch", false],
    ["pull_request", true],
  ] as const) {
    const plan = planCiApiTests({
      event,
      scopeUnknown,
      testJobs: ["rest-web"],
      select: () => {
        throw new Error("selector should not run");
      },
    });
    expect(plan.impact).toEqual(allApiTests());
    expect(matrixShards(plan)).toEqual([
      "api-1",
      "api-2",
      "api-3",
      "api-4",
      "api-5",
      "api-6",
      "rest-web",
    ]);
  }
});

test("crashes and malformed selector output cannot remove API work", () => {
  expect(
    planCiApiTests({
      event: "pull_request",
      scopeUnknown: false,
      testJobs: FULL_TEST_JOB_SHARDS,
      select: () => {
        throw new Error("planted crash");
      },
    }).impact,
  ).toEqual(allApiTests());
  for (const output of [
    "bad JSON",
    "{}",
    '{"mode":"none","files":[],"shards":4}',
    '{"mode":"selected","files":[],"shards":0}',
    JSON.stringify({ ...selected(), shards: 4 }),
    JSON.stringify({
      ...selected(),
      files: ["src/a.test.ts", "src/a.test.ts"],
    }),
    JSON.stringify({
      ...selected(),
      files: ["src/../../outside.test.ts", "src/a.test.ts"],
    }),
  ]) {
    expect(parseApiTestImpact(output)).toEqual(allApiTests());
  }
  expect(parseApiTestImpact(JSON.stringify(selected()))).toEqual(selected());
});

test("merge groups select the batch union without narrowing API test files", () => {
  const options = {
    event: "merge_group",
    scopeUnknown: false,
    testJobs: ["rest-web"],
    select: () => {
      throw new Error("merge groups must retain whole affected API suites");
    },
  } as const;
  expect(matrixShards(planCiApiTests(options))).toEqual(["rest-web"]);
  expect(
    planCiApiTests({
      ...options,
      testJobs: FULL_TEST_JOB_SHARDS,
    }).impact,
  ).toEqual(allApiTests());
  expect(
    matrixShards(planCiApiTests({ ...options, scopeUnknown: true })),
  ).toHaveLength(FULL_TEST_JOB_SHARDS.length);
});

test("plans skip exactly when no selected shard survives", () => {
  assertProperty(
    "plans skip exactly when no selected shard survives",
    fc.property(
      fc.subarray([...FULL_TEST_JOB_SHARDS]),
      fc.constantFrom("pull_request", "merge_group", "workflow_dispatch"),
      fc.boolean(),
      fc.integer({ min: 0, max: 3 }),
      (testJobs, event, scopeUnknown, apiShards) => {
        const plan = planCiApiTests({
          event,
          scopeUnknown,
          testJobs,
          select: () =>
            apiShards === 0
              ? { mode: "none", files: [], shards: 0 }
              : {
                  mode: "selected",
                  files: Array.from(
                    { length: apiShards },
                    (_, index) => `src/${index}.test.ts`,
                  ),
                  shards: apiShards,
                },
        });
        const scopedEvent =
          !scopeUnknown && ["pull_request", "merge_group"].includes(event);
        const expectedShards = FULL_TEST_JOB_SHARDS.filter(
          (shard) => !scopedEvent || testJobs.includes(shard),
        ).filter(
          (shard) =>
            !shard.startsWith("api-") ||
            event === "merge_group" ||
            !scopedEvent ||
            Number(shard.slice(4)) <= apiShards,
        );

        expect(plan.type === "skip").toBe(expectedShards.length === 0);
        if (plan.type === "run") {
          expect(plan.matrix.shard.length).toBeGreaterThan(0);
          expect([...plan.matrix.shard]).toEqual(expectedShards);
        }
      },
    ),
  );
});

test("every planned matrix job gates on its matching required output", () => {
  const workflow = v.parse(
    v.object({
      jobs: v.record(
        v.string(),
        v.object({
          if: v.optional(v.string()),
          strategy: v.optional(v.object({ matrix: v.optional(v.unknown()) })),
        }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
        "utf-8",
      ),
    ),
  );
  const plannedJobs = Object.entries(workflow.jobs).filter(
    ([, job]) =>
      typeof job.strategy?.matrix === "string" &&
      /^\$\{\{ fromJSON\(needs\.ci-plan\.outputs\.[a-z0-9_]+\) \}\}$/u.test(
        job.strategy.matrix,
      ),
  );
  expect(plannedJobs.length).toBeGreaterThan(0);
  for (const [name, job] of plannedJobs) {
    const matrix = job.strategy?.matrix;
    const matrixOutput =
      typeof matrix === "string"
        ? /outputs\.([a-z0-9_]+)\)/u.exec(matrix)?.at(1)
        : undefined;
    if (matrixOutput === undefined) {
      throw new TypeError(`${name} matrix names no ci-plan output`);
    }
    expect(matrixOutput, `${name} matrix output`).toEndWith("_matrix");
    const requiredOutput = `${matrixOutput.slice(0, -"matrix".length)}required`;
    expect(job.if, `${name} must gate its planned matrix`).toContain(
      `needs.ci-plan.outputs.${requiredOutput} == 'true'`,
    );
  }
});

test("matrix admission follows the executable Turbo test plan", () => {
  const turboPlan = (packages: readonly string[]) =>
    JSON.stringify({
      tasks: packages.map((packageName) => ({
        package: packageName,
        task: "test",
      })),
    });
  expect(selectedTestJobs(turboPlan(["@stll/web"]))).toEqual(["rest-web"]);
  expect(selectedTestJobs(turboPlan(["@stll/api"]))).toEqual(
    FULL_TEST_JOB_SHARDS.filter((shard) => shard !== "rest-web"),
  );
  expect(selectedTestJobs(turboPlan([]))).toEqual([]);
});
