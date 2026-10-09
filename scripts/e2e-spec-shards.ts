import { Result, panic } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { buildImportGraph } from "./api-test-impact";
import {
  allE2eShards,
  e2eShardForSpec,
  listE2eSpecs,
} from "./e2e-spec-shards-core";

export {
  E2E_SHARD_COUNT,
  e2eShardForSpec,
  e2eSpecsForShard,
  listE2eSpecs,
} from "./e2e-spec-shards-core";
// Runner configuration and global setup load every spec without being imported.
const E2E_RUNNER_ROOT = "apps/web/e2e/";
const SPEC_SUFFIX = ".spec.ts";

type E2eSpecSelection =
  | { status: "all" }
  | { status: "resolved"; specs: string[] };

const selectE2eSpecPlan = (
  changedFiles: readonly string[],
  root = process.cwd(),
): E2eSpecSelection => {
  const specs = listE2eSpecs(root);
  if (changedFiles.length === 0) {
    return { status: "resolved", specs: [] };
  }
  // Missing inputs and graph uncertainty cannot prove a shard is unaffected.
  if (changedFiles.some((file) => !existsSync(path.join(root, file)))) {
    return { status: "all" };
  }
  const result = Result.try(() =>
    buildImportGraph(realpathSync(root), [...specs, ...changedFiles]),
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
  const closures = new Map(specs.map((spec) => [spec, graph.closure(spec)]));
  const imported = new Set(
    [...closures.values()].flatMap((closure) => [...closure]),
  );
  if (
    changedFiles.some(
      (file) =>
        file.startsWith(E2E_RUNNER_ROOT) &&
        !file.endsWith(SPEC_SUFFIX) &&
        !imported.has(file),
    )
  ) {
    return { status: "all" };
  }
  const changed = new Set(changedFiles);
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

export const selectedE2eShards = (
  changedFiles: readonly string[],
  root = process.cwd(),
): number[] => {
  const selection = selectE2eSpecPlan(changedFiles, root);
  if (selection.status === "all") {
    return allE2eShards();
  }
  const specs = listE2eSpecs(root);
  return [
    ...new Set(selection.specs.map((spec) => e2eShardForSpec(spec, specs))),
  ].toSorted((left, right) => left - right);
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "select") {
    const shards = selectedE2eShards(args);
    process.stdout.write(JSON.stringify({ shard: shards }));
  } else {
    panic(`Unknown e2e shard command: ${command ?? "missing"}`);
  }
}
