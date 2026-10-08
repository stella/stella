import { Result, panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import type { GatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { discoverGatedTestFiles } from "../apps/api/scripts/run-gated-tests";
import { API_ALL_RULES, selectApiTestImpact } from "./api-test-impact";

const repositoryRoot = path.resolve(import.meta.dir, "..");

type AssertPostgresDiscoveryOptions = {
  discovered: readonly string[];
  gated: readonly string[];
  selectorFiles: readonly string[];
};

export const assertPostgresDiscovery = ({
  discovered,
  gated,
  selectorFiles,
}: AssertPostgresDiscoveryOptions) => {
  const selectable = new Set(selectorFiles);
  const runners = new Set(discovered);
  const expected = new Set(gated);
  const missing = gated.filter(
    (file) => !selectable.has(file) || !runners.has(file),
  );
  const stale = discovered.filter((file) => !expected.has(file));
  if (gated.length === 0 || missing.length > 0 || stale.length > 0) {
    panic(
      `Postgres discovery mismatch: missing=${missing.join(",")}; stale=${stale.join(",")}; gated=${gated.length}`,
    );
  }
};

type PlanPostgresTestsOptions = {
  event: string;
  scopeUnknown: boolean;
  changed: readonly string[];
  root?: string;
};

export const planPostgresTests = async ({
  event,
  scopeUnknown,
  changed,
  root = repositoryRoot,
}: PlanPostgresTestsOptions): Promise<GatedTestSelection> => {
  if (
    (event !== "merge_group" && event !== "pull_request") ||
    scopeUnknown ||
    changed.length === 0
  ) {
    return { mode: "all" };
  }

  // Paths outside the import graph and its widening rules cannot prove absence.
  if (
    changed.some(
      (file) =>
        !Object.values(API_ALL_RULES).some((rule) => rule.test(file)) &&
        !/^(?:apps|packages)\/[^/]+\/.+\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file),
    )
  ) {
    return { mode: "all" };
  }

  const planned = await Result.tryPromise(async () => {
    const apiRoot = path.join(root, "apps/api");
    const metadata = v.parse(
      v.object({
        ciGateTestRunners: v.object({
          "test:postgres": v.object({
            gate: v.string(),
            testFileGlob: v.string(),
          }),
        }),
      }),
      JSON.parse(readFileSync(path.join(apiRoot, "package.json"), "utf-8")),
    );
    const runner = metadata.ciGateTestRunners["test:postgres"];
    if (runner.gate !== "STELLA_RUN_POSTGRES_TESTS") {
      panic("Unexpected Postgres test gate");
    }
    const selectorFiles = listApiTestPaths(apiRoot);
    const gated = selectorFiles.filter((file) =>
      readFileSync(path.join(apiRoot, file), "utf-8").includes(runner.gate),
    );
    const discovered = await discoverGatedTestFiles({ apiRoot, ...runner });
    assertPostgresDiscovery({ discovered, gated, selectorFiles });
    const impact = selectApiTestImpact({
      root,
      changed,
      graphFailurePolicy: "all",
    });
    switch (impact.mode) {
      case "all":
        return { mode: "all" } as const;
      case "none":
        return { mode: "none" } as const;
      case "selected": {
        const postgres = new Set(discovered);
        const files = impact.files.filter((file) => postgres.has(file));
        return files.length === 0
          ? ({ mode: "none" } as const)
          : ({ mode: "selected", files } as const);
      }
      default:
        impact.mode satisfies never;
        return panic("Unhandled API test impact mode");
    }
  });
  if (planned.isErr()) {
    console.warn(
      "Postgres selection unavailable; running the full suite.",
      planned.error,
    );
    return { mode: "all" };
  }
  return planned.value;
};

if (import.meta.main) {
  const input = Result.try(() =>
    readFileSync(
      path.join(
        process.env["RUNNER_TEMP"] ?? panic("Missing RUNNER_TEMP"),
        "api-test-changed-paths",
      ),
      "utf-8",
    )
      .split("\0")
      .filter(Boolean),
  );
  const selection = input.isErr()
    ? ({ mode: "all" } as const)
    : await planPostgresTests({
        event: process.env["EVENT_NAME"] ?? "",
        scopeUnknown: process.env["API_SCOPE_UNKNOWN"] !== "false",
        changed: input.value,
      });
  const reasons = {
    all: "Full coverage retained: event policy, widening rule, or uncertain analysis.",
    none: "No Postgres files affected by the changed runtime import graph.",
    selected: "Postgres files reachable from the changed runtime import graph.",
  } as const satisfies Record<GatedTestSelection["mode"], string>;
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? panic("Missing GITHUB_OUTPUT"),
    `postgres_test_selection=${JSON.stringify(selection)}\npostgres_selection_reason=${reasons[selection.mode]}\n`,
  );
}
