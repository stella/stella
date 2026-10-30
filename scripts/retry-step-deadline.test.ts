import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as v from "valibot";

// A step deadline shorter than retry.sh's own envelope silently removes the
// later attempts. Every bounded step that wraps retry.sh must fit all attempts.
const MIN_SECONDS_PER_ATTEMPT = 15;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAYS = "15 45";

const envSchema = v.optional(
  v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
);
const stepSchema = v.object({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  env: envSchema,
  "timeout-minutes": v.optional(v.union([v.number(), v.string()])),
});
type Step = v.InferOutput<typeof stepSchema>;
const matrixLegSchema = v.record(v.string(), v.unknown());
type MatrixLeg = v.InferOutput<typeof matrixLegSchema>;
const fileSchema = v.object({
  env: envSchema,
  jobs: v.optional(
    v.record(
      v.string(),
      v.object({
        env: envSchema,
        steps: v.optional(v.array(stepSchema)),
        strategy: v.optional(
          v.object({
            matrix: v.optional(
              v.union([
                v.string(),
                v.object({
                  include: v.optional(
                    v.union([v.string(), v.array(matrixLegSchema)]),
                  ),
                }),
              ]),
            ),
          }),
        ),
      }),
    ),
  ),
  runs: v.optional(v.object({ steps: v.optional(v.array(stepSchema)) })),
});

type Env = Record<string, string | number | boolean>;
type BoundedStep = { where: string; step: Step; env: Env };

// A deadline may name one matrix value; each `include` leg is then checked
// with its own value. Any other expression stays unreadable, so it fails.
const MATRIX_DEADLINE = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/u;
export const deadlineLegs = (
  bounded: BoundedStep,
  legs: readonly MatrixLeg[],
): BoundedStep[] => {
  const timeout = bounded.step["timeout-minutes"];
  const key =
    typeof timeout === "string"
      ? MATRIX_DEADLINE.exec(timeout)?.at(1)
      : undefined;
  if (key === undefined || legs.length === 0) {
    return [bounded];
  }
  return legs.map((leg, index) => {
    const value = leg[key];
    return {
      ...bounded,
      where: `${bounded.where} [matrix leg ${String(index + 1)}]`,
      step: {
        ...bounded.step,
        "timeout-minutes":
          typeof value === "number" || typeof value === "string"
            ? value
            : "missing",
      },
    };
  });
};

const root = new URL("../.github/", import.meta.url);
const boundedRetrySteps = (): BoundedStep[] => {
  const files = [
    ...readdirSync(new URL("workflows/", root))
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => `workflows/${name}`),
    ...readdirSync(new URL("actions/", root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        ["action.yml", "action.yaml"]
          .map((name) => `actions/${entry.name}/${name}`)
          .filter((path) => existsSync(new URL(path, root))),
      ),
  ];
  const found: BoundedStep[] = [];
  for (const path of files) {
    const parsed = v.parse(
      fileSchema,
      Bun.YAML.parse(readFileSync(new URL(path, root), "utf-8")),
    );
    const groups: {
      where: string;
      env: Env;
      steps: Step[];
      legs: readonly MatrixLeg[];
    }[] = [
      ...Object.entries(parsed.jobs ?? {}).map(([id, job]) => {
        const matrix = job.strategy?.matrix;
        return {
          where: `${path} ${id}`,
          env: { ...parsed.env, ...job.env },
          steps: job.steps ?? [],
          legs:
            typeof matrix === "object" && Array.isArray(matrix.include)
              ? matrix.include
              : [],
        };
      }),
      { where: path, env: {}, steps: parsed.runs?.steps ?? [], legs: [] },
    ];
    for (const group of groups) {
      for (const step of group.steps) {
        if (
          step["timeout-minutes"] !== undefined &&
          step.run?.includes("retry.sh")
        ) {
          found.push(
            ...deadlineLegs(
              {
                where: `${group.where} "${step.name ?? step.run}"`,
                step,
                env: { ...group.env, ...step.env },
              },
              group.legs,
            ),
          );
        }
      }
    }
  }
  return found;
};

export const retryEnvelopeViolation = ({ where, step, env }: BoundedStep) => {
  const attempts = Number(env["RETRY_ATTEMPTS"] ?? DEFAULT_ATTEMPTS);
  const delays = String(env["RETRY_DELAYS_SECONDS"] ?? DEFAULT_DELAYS)
    .trim()
    .split(/\s+/u)
    .map(Number);
  let sleeps = 0;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    sleeps += delays[Math.min(attempt, delays.length) - 1] ?? 0;
  }
  const needed = sleeps + attempts * MIN_SECONDS_PER_ATTEMPT;
  const deadline = Number(step["timeout-minutes"]) * 60;
  return deadline >= needed
    ? undefined
    : `${where}: ${deadline}s deadline < ${needed}s retry envelope`;
};

test("every bounded step that wraps retry.sh fits all of its attempts", () => {
  const steps = boundedRetrySteps();
  // Composite installs no longer retry; the invariant also covers an empty census.
  expect(steps.map(retryEnvelopeViolation).filter(Boolean)).toEqual([]);
});

test("a matrix deadline is checked on every leg, and other expressions fail", () => {
  const bounded = (timeout: string): BoundedStep => ({
    where: "x",
    step: { run: "bash scripts/retry.sh bun ci", "timeout-minutes": timeout },
    env: {},
  });
  const violations = (timeout: string, legs: readonly MatrixLeg[]) =>
    deadlineLegs(bounded(timeout), legs).map(retryEnvelopeViolation);

  const githubExpression = (inner: string) => `\${{ ${inner} }}`;
  const matrixDeadline = githubExpression("matrix.install_timeout_minutes");
  expect(
    violations(matrixDeadline, [
      { install_timeout_minutes: 30 },
      { install_timeout_minutes: 5 },
    ]),
  ).toEqual([undefined, undefined]);
  expect(
    violations(matrixDeadline, [
      { install_timeout_minutes: 30 },
      { install_timeout_minutes: 1 },
    ]),
  ).toEqual([
    undefined,
    "x [matrix leg 2]: 60s deadline < 105s retry envelope",
  ]);
  expect(violations(matrixDeadline, [{ os: "macos" }])[0]).toBeString();
  expect(violations(matrixDeadline, [])[0]).toBeString();
  expect(
    violations(githubExpression("matrix.os == 'windows' && 30 || 5"), [
      { os: "windows" },
    ])[0],
  ).toBeString();
});

test("the retry envelope guard rejects a deadline that cuts off the last attempt", () => {
  const step = { run: "bash scripts/retry.sh bun ci", "timeout-minutes": 1 };
  expect(retryEnvelopeViolation({ where: "x", step, env: {} })).toBeString();
  expect(
    retryEnvelopeViolation({
      where: "x",
      step: { ...step, "timeout-minutes": 2 },
      env: { RETRY_DELAYS_SECONDS: "5 10" },
    }),
  ).toBeUndefined();
  expect(
    retryEnvelopeViolation({
      where: "x",
      step: { ...step, "timeout-minutes": 2 },
      env: { RETRY_ATTEMPTS: "6", RETRY_DELAYS_SECONDS: "5 10" },
    }),
  ).toBeString();
});
