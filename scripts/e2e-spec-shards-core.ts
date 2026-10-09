import assert from "node:assert";
import { readdirSync } from "node:fs";
import path from "node:path";

export const E2E_SHARD_COUNT = 2;
const SPEC_ROOT = "apps/web/e2e/specs";
const SPEC_SUFFIX = ".spec.ts";

export const compareCodeUnit = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

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
  assert.ok(index !== -1, `Unknown e2e spec: ${spec}`);
  return (index % E2E_SHARD_COUNT) + 1;
};

export const e2eSpecsForShard = (
  shard: number,
  specs: readonly string[],
): string[] => {
  assert.ok(
    Number.isInteger(shard) && shard >= 1 && shard <= E2E_SHARD_COUNT,
    `Invalid e2e shard: ${shard}`,
  );
  return specs.filter((spec) => e2eShardForSpec(spec, specs) === shard);
};

export const allE2eShards = (): number[] =>
  Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1);

export const allE2eMatrix = (): { shard: (number | string)[] } => ({
  shard: [...allE2eShards(), "network-baseline"],
});

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "files") {
    const shard = Number(args.at(0));
    process.stdout.write(e2eSpecsForShard(shard, listE2eSpecs()).join("\n"));
  } else if (command === "all") {
    process.stdout.write(JSON.stringify(allE2eMatrix()));
  } else {
    assert.fail(`Unknown e2e shard command: ${command ?? "missing"}`);
  }
}
