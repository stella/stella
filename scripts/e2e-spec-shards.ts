import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

export const E2E_SHARD_COUNT = 2;
const SPEC_ROOT = "apps/web/e2e/specs";
const E2E_ROOT = "apps/web/e2e";
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

const importedPaths = (file: string, root: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(root, file), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const request = statement.moduleSpecifier.text;
    if (!request.startsWith(".")) {
      continue;
    }
    const base = path.join(path.dirname(file), request);
    for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
      if (!existsSync(path.join(root, candidate))) {
        continue;
      }
      imports.push(candidate);
      break;
    }
  }
  return imports;
};

const dependencyClosure = (spec: string, root: string): Set<string> => {
  const seen = new Set<string>();
  const pending = [spec];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    pending.push(...importedPaths(file, root));
  }
  return seen;
};

export const selectE2eSpecs = (
  changedFiles: readonly string[],
  root = process.cwd(),
): string[] => {
  const changed = new Set(
    changedFiles.filter(
      (file) =>
        file.startsWith(`${E2E_ROOT}/`) && existsSync(path.join(root, file)),
    ),
  );
  if (changed.size === 0) {
    return [];
  }
  return listE2eSpecs(root).filter((spec) => {
    for (const dependency of dependencyClosure(spec, root)) {
      if (changed.has(dependency)) {
        return true;
      }
    }
    return false;
  });
};

export const selectedE2eShards = (
  changedFiles: readonly string[],
  root = process.cwd(),
): number[] => {
  const specs = listE2eSpecs(root);
  return [
    ...new Set(
      selectE2eSpecs(changedFiles, root).map((spec) =>
        e2eShardForSpec(spec, specs),
      ),
    ),
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
