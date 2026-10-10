import { Result, panic } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { buildImportGraph } from "./api-test-impact";
import {
  ROUTE_SMOKE_SPEC_PATH,
  routeSmokeAffected,
} from "./detect-route-smoke-changes";
import { e2eRunnerInputs } from "./e2e-runner-inputs";
import {
  allE2eMatrix,
  isPlaywrightTestFile,
  listE2eSpecs,
} from "./e2e-spec-shards-core";

export { E2E_SHARD_COUNT, listE2eSpecs } from "./e2e-spec-shards-core";
// Runner configuration and global setup load every spec without being imported.
const E2E_RUNNER_ROOT = "apps/web/e2e/";

type E2eSpecSelection =
  | { status: "all" }
  | { status: "resolved"; specs: string[] };

const selectE2eSpecPlan = (
  changedFiles: readonly string[],
  root = process.cwd(),
): E2eSpecSelection => {
  const specs = listE2eSpecs(root);
  // Missing inputs and graph uncertainty cannot prove a shard is unaffected.
  if (changedFiles.some((file) => !existsSync(path.join(root, file)))) {
    return { status: "all" };
  }
  const runnerInputs = Result.try(() => e2eRunnerInputs(root));
  if (runnerInputs.isErr() || runnerInputs.value === undefined) {
    return { status: "all" };
  }
  if (changedFiles.length === 0) {
    return { status: "resolved", specs: [] };
  }
  const entries = runnerInputs.value;
  const result = Result.try(() =>
    buildImportGraph(realpathSync(root), [
      ...entries,
      ...specs,
      ...changedFiles,
    ]),
  );
  if (result.isErr()) {
    return { status: "all" };
  }
  const graph = result.value;
  if (
    graph.failed.size > 0 ||
    graph.computedImports.size > 0 ||
    graph.scanners.size > 0 ||
    graph.readers.size > 0
  ) {
    return { status: "all" };
  }
  const changed = new Set(changedFiles);
  if (
    entries.some((entry) =>
      [...graph.closure(entry)].some((file) => changed.has(file)),
    )
  ) {
    return { status: "all" };
  }
  const closures = new Map(specs.map((spec) => [spec, graph.closure(spec)]));
  const imported = new Set(
    [...closures.values()].flatMap((closure) => [...closure]),
  );
  if (
    changedFiles.some(
      (file) =>
        file.startsWith(E2E_RUNNER_ROOT) &&
        !isPlaywrightTestFile(file) &&
        !imported.has(file),
    )
  ) {
    return { status: "all" };
  }
  return {
    status: "resolved",
    specs: specs.filter((spec) =>
      [...(closures.get(spec) ?? [])].some((dependency) =>
        changed.has(dependency),
      ),
    ),
  };
};

export const selectE2eSpecs = (
  changedFiles: readonly string[],
  root = process.cwd(),
): string[] => {
  const selection = selectE2eSpecPlan(changedFiles, root);
  switch (selection.status) {
    case "all":
      return listE2eSpecs(root);
    case "resolved":
      return selection.specs;
    default: {
      selection satisfies never;
      return panic("Unhandled e2e spec selection status");
    }
  }
};

export const selectedE2ePlan = (
  changedFiles: readonly string[],
  root = process.cwd(),
) => {
  const selection = selectE2eSpecPlan(changedFiles, root);
  if (selection.status === "all") {
    return { status: "full", matrix: allE2eMatrix(), specs: [] } as const;
  }
  // The dedicated network leg owns route smoke; the general run excludes it.
  const specs = selection.specs.filter(
    (spec) => spec !== ROUTE_SMOKE_SPEC_PATH,
  );
  const specialLegs = allE2eMatrix().shard.filter(
    (leg) => typeof leg !== "number",
  );
  return {
    status: "selected",
    matrix: {
      shard: [
        ...(specs.length > 0 ? [1] : []),
        ...(routeSmokeAffected(changedFiles, root) ? specialLegs : []),
      ],
    },
    specs,
  } as const;
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "select") {
    process.stdout.write(JSON.stringify(selectedE2ePlan(args)));
  } else {
    panic(`Unknown e2e shard command: ${command ?? "missing"}`);
  }
}
