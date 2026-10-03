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
  "",
].join("\n");

const ALLOWED_FILE = "apps/api/src/lib/scheduler/jobs.ts";

const lint = async (sourcePath: string) =>
  await lintSingleRule("no-raw-deployment-feature-read", SOURCE, {
    ruleOptions: {
      allowedReads: [
        { file: ALLOWED_FILE, flags: ["FEATURE_GOVERNED_WORKFLOW"] },
      ],
    },
    sourcePath,
  });

describe.serial("no-raw-deployment-feature-read", () => {
  test("reports every raw flag read outside the allowlist", async () => {
    expect(await lint("apps/api/src/lib/example.ts")).toEqual([3, 4, 5, 6, 7]);
  });

  test("accepts only the allowlisted flag in the allowlisted file", async () => {
    expect(await lint(ALLOWED_FILE)).toEqual([3, 4, 5, 6]);
  });

  test("accepts test files", async () => {
    expect(await lint("apps/api/src/lib/example.test.ts")).toEqual([]);
  });
});
