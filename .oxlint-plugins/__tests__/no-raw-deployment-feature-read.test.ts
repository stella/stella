import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// The test-file exemption and the per-file allowlist are path-scoped, which
// the passive fixture under `.oxlint-plugins/__fixtures__` cannot exercise.
const SOURCE = [
  "declare const env: Record<string, boolean>;",
  "declare const owner: (flag: string) => boolean;",
  "export const member = env.FEATURE_LEGAL_LISTS;",
  "export const optional = env?.FEATURE_PUBLIC_LAW;",
  'export const computed = env["FEATURE_AI_MEMORY"];',
  "const { FEATURE_USAGE: destructured } = env;",
  "export const allowed = env.FEATURE_GOVERNED_WORKFLOW;",
  'export const owned = owner("FEATURE_LEGAL_LISTS");',
  "export const other = env.ACTION_COST_RETENTION_DAYS;",
  "export const worker = envWorker.FEATURE_FILE_USAGE_LIMITS;",
  "void destructured;",
  "export const processRead = process.env.FEATURE_LEGAL_LISTS;",
  'export const bunRead = Bun.env["FEATURE_USAGE"];',
  "export const metaRead = import.meta.env.FEATURE_USAGE;",
  "export const globalRead = globalThis.process.env.FEATURE_USAGE;",
  "const { FEATURE_AI_MEMORY: fromProcess } = process.env;",
  "export const processOther = process.env.NODE_ENV;",
  "void fromProcess;",
  "",
].join("\n");

const PROCESS_ENV_LINES = [12, 13, 14, 15, 16];

const ALLOWED_FILE = "apps/api/src/lib/scheduler/jobs.ts";

const lint = async (sourcePath: string, processEnvOnly = false) =>
  await lintSingleRule("no-raw-deployment-feature-read", SOURCE, {
    ruleOptions: {
      ...(processEnvOnly ? { processEnvOnly } : {}),
      allowedReads: [
        { file: ALLOWED_FILE, flags: ["FEATURE_GOVERNED_WORKFLOW"] },
      ],
    },
    sourcePath,
  });

describe.serial("no-raw-deployment-feature-read", () => {
  test("reports every raw flag read outside the allowlist", async () => {
    expect(await lint("apps/api/src/lib/example.ts")).toEqual([
      3,
      4,
      5,
      6,
      7,
      ...PROCESS_ENV_LINES,
    ]);
  });

  test("accepts only the allowlisted flag in the allowlisted file", async () => {
    expect(await lint(ALLOWED_FILE)).toEqual([
      3,
      4,
      5,
      6,
      ...PROCESS_ENV_LINES,
    ]);
  });

  test("outside the API, reports only process-environment reads", async () => {
    expect(await lint("packages/example/src/flags.ts", true)).toEqual(
      PROCESS_ENV_LINES,
    );
  });

  test("accepts test files", async () => {
    expect(await lint("apps/api/src/lib/example.test.ts")).toEqual([]);
  });
});
