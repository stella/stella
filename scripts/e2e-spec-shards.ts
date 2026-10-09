import { Result, panic } from "better-result";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { buildImportGraph } from "./api-test-impact";

export const E2E_SHARD_COUNT = 2;
const SPEC_ROOT = "apps/web/e2e/specs";
// Runner configuration and global setup load every spec without being imported.
const E2E_RUNNER_ROOT = "apps/web/e2e/";
const SPEC_SUFFIX = ".spec.ts";

const walk = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(child));
    } else if (entry.isFile() && child.endsWith(SPEC_SUFFIX)) {
      files.push(child);
    }
  }
  return files;
};

export const listE2eSpecs = (root = process.cwd()): string[] =>
  walk(path.join(root, SPEC_ROOT))
    .map((file) => path.relative(root, file))
    .toSorted(compareCodeUnit);

export const e2eShardForSpec = (
  spec: string,
  specs: readonly string[],
): number => {
  const index = specs.indexOf(spec);
  if (index === -1) {
    panic(`Unknown e2e spec: ${spec}`);
  }
  return (index % E2E_SHARD_COUNT) + 1;
};

export const e2eSpecsForShard = (
  shard: number,
  specs: readonly string[],
): string[] => {
  if (!Number.isInteger(shard) || shard < 1 || shard > E2E_SHARD_COUNT) {
    panic(`Invalid e2e shard: ${shard}`);
  }
  return specs.filter((spec) => e2eShardForSpec(spec, specs) === shard);
};

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
    return Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1);
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
  } else if (command === "files") {
    const shard = Number(args.at(0));
    const specs = listE2eSpecs();
    process.stdout.write(e2eSpecsForShard(shard, specs).join("\n"));
  } else if (command === "all") {
    process.stdout.write(
      JSON.stringify({
        shard: [
          ...Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1),
          "network-baseline",
        ],
      }),
    );
  } else {
    panic(`Unknown e2e shard command: ${command ?? "missing"}`);
  }
}
