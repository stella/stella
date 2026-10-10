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
const fileSchema = v.object({
  env: envSchema,
  jobs: v.optional(
    v.record(
      v.string(),
      v.object({ env: envSchema, steps: v.optional(v.array(stepSchema)) }),
    ),
  ),
  runs: v.optional(v.object({ steps: v.optional(v.array(stepSchema)) })),
});

type Env = Record<string, string | number | boolean>;
type BoundedStep = { where: string; step: Step; env: Env };

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
    const groups: { where: string; env: Env; steps: Step[] }[] = [
      ...Object.entries(parsed.jobs ?? {}).map(([id, job]) => ({
        where: `${path} ${id}`,
        env: { ...parsed.env, ...job.env },
        steps: job.steps ?? [],
      })),
      { where: path, env: {}, steps: parsed.runs?.steps ?? [] },
    ];
    for (const group of groups) {
      for (const step of group.steps) {
        if (
          step["timeout-minutes"] !== undefined &&
          step.run?.includes("retry.sh")
        ) {
          found.push({
            where: `${group.where} "${step.name ?? step.run}"`,
            step,
            env: { ...group.env, ...step.env },
          });
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
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.map(retryEnvelopeViolation).filter(Boolean)).toEqual([]);
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
