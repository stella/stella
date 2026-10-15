import { TaggedError } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

export type RustTarget = {
  file: string;
  cwd: string;
  crate: string;
  module: string;
};

export type RustSelection = {
  targets: RustTarget[];
  unsupported: { file: string; reason: string }[];
};

class RustListingError extends TaggedError("RustListingError")<{
  message: string;
}> {}

const MAX_SELECTED_TEST_BYTES = 4 * 1024 * 1024;
const MAX_TEST_BATCH_BYTES = 24 * 1024;
const MAX_TEST_BATCH_COUNT = 128;
const TEST_LIST_SUFFIX = ": test";

export const rustTestBelongsToModule = ({
  name,
  module,
}: {
  name: string;
  module: string;
}) => module === "" || name === module || name.startsWith(`${module}::`);

/** Discovery is streamed independently of the bounded diagnostic output tail. */
export const createRustTestListing = (module: string) => {
  const selected = new Set<string>();
  let selectedBytes = 0;
  return {
    acceptLine: (line: string) => {
      if (!line.endsWith(TEST_LIST_SUFFIX)) {
        return;
      }
      const name = line.slice(0, -TEST_LIST_SUFFIX.length);
      if (!rustTestBelongsToModule({ name, module }) || selected.has(name)) {
        return;
      }
      const bytes = Buffer.byteLength(name, "utf-8") + 1;
      if (bytes > MAX_TEST_BATCH_BYTES) {
        throw new RustListingError({
          message: "Rust test name exceeds the exact-test argument budget",
        });
      }
      selectedBytes += bytes;
      if (selectedBytes > MAX_SELECTED_TEST_BYTES) {
        throw new RustListingError({
          message: "Rust test listing exceeds the selected-name budget",
        });
      }
      selected.add(name);
    },
    batches: () => {
      const batches: string[][] = [];
      let batch: string[] = [];
      let bytes = 0;
      for (const name of [...selected].toSorted()) {
        const nameBytes = Buffer.byteLength(name, "utf-8") + 1;
        if (
          batch.length >= MAX_TEST_BATCH_COUNT ||
          bytes + nameBytes > MAX_TEST_BATCH_BYTES
        ) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(name);
        bytes += nameBytes;
      }
      if (batch.length > 0) {
        batches.push(batch);
      }
      return batches;
    },
  };
};

export const rustListCommand = ({ crate }: Pick<RustTarget, "crate">) => [
  "cargo",
  "test",
  "-p",
  crate,
  "--lib",
  "--color=never",
  "--",
  "--list",
  "--format=terse",
];

export const rustExactCommand = ({
  crate,
  names,
}: Pick<RustTarget, "crate"> & { names: readonly string[] }) => [
  "cargo",
  "test",
  "-p",
  crate,
  "--lib",
  "--color=never",
  "--",
  "--exact",
  "--test-threads=1",
  ...names,
];

const unsupportedLibrary = (manifest: Record<string, unknown>, cwd: string) => {
  const library = manifest["lib"];
  if (typeof library === "object" && library !== null) {
    if ("harness" in library && library.harness === false) {
      return "custom Rust test harnesses need an explicit runner";
    }
    if ("path" in library && library.path !== "src/lib.rs") {
      return "custom Rust library roots need an explicit module mapping";
    }
  }
  const pkg = manifest["package"];
  if (
    library === undefined &&
    typeof pkg === "object" &&
    pkg !== null &&
    "autolib" in pkg &&
    pkg.autolib === false
  ) {
    return "package has no automatic Rust library target";
  }
  return existsSync(path.join(cwd, "src/lib.rs"))
    ? null
    : "package has no src/lib.rs library target";
};

const moduleFor = (crateDir: string, file: string) => {
  const relative = repoRelativePath(crateDir, file);
  const source = relative.startsWith("src/") ? relative.slice(4) : relative;
  const withoutExtension = source.replace(/\.rs$/u, "");
  const parts = withoutExtension.split("/");
  const final = parts.at(-1);
  if (final === undefined) {
    return undefined;
  }
  if (final === "lib" || final === "main" || final === "mod") {
    parts.pop();
  }
  return parts.filter((part) => part !== "mod").join("::");
};

const hasTest = (file: string) => {
  const source = readFileSync(file, "utf-8");
  for (const attribute of source.matchAll(
    /#\s*\[\s*(?:[A-Za-z_]\w*\s*::\s*)*test\s*(?=\]|\()/gu,
  )) {
    const start = attribute.index + attribute[0].length;
    if (source[start] === "]") {
      return true;
    }
    let depth = 0;
    // Quoted arguments may contain parentheses; only delimiter tokens count.
    const tokens =
      /(?:br|r)(?<hashes>#{0,})"[\s\S]*?"\k<hashes>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[()]/gu;
    tokens.lastIndex = start;
    for (const token of source.matchAll(tokens)) {
      if (token[0] === "(") {
        depth += 1;
      } else if (token[0] === ")") {
        depth -= 1;
        if (depth === 0) {
          if (/^\s*\]/u.test(source.slice(token.index + 1))) {
            return true;
          }
          break;
        }
      }
    }
  }
  return false;
};

export const selectRustTargets = (
  root: string,
  changed: readonly string[],
): RustSelection => {
  const rustChanges = changed.filter((file) => file.endsWith(".rs"));
  if (rustChanges.length === 0) {
    return { targets: [], unsupported: [] };
  }

  const targets = new Map<string, RustTarget>();
  const unsupported: RustSelection["unsupported"] = [];
  const rootPath = path.resolve(root);
  const packages = new Map<
    string,
    { cwd: string; crate: string; unsupported: string | null } | null
  >();
  const packageFor = (absolute: string) => {
    let directory = path.dirname(absolute);
    while (
      directory === rootPath ||
      directory.startsWith(`${rootPath}${path.sep}`)
    ) {
      if (packages.has(directory)) {
        const cached = packages.get(directory);
        if (cached !== null) {
          return cached;
        }
      }
      const manifestPath = path.join(directory, "Cargo.toml");
      if (existsSync(manifestPath)) {
        const manifest = Bun.TOML.parse(readFileSync(manifestPath, "utf-8"));
        const pkg = "package" in manifest ? manifest.package : undefined;
        if (
          typeof pkg === "object" &&
          pkg !== null &&
          "name" in pkg &&
          typeof pkg.name === "string"
        ) {
          const result = {
            cwd: directory,
            crate: pkg.name,
            unsupported: unsupportedLibrary(manifest, directory),
          };
          packages.set(directory, result);
          return result;
        }
        packages.set(directory, null);
      }
      if (directory === rootPath) {
        break;
      }
      directory = path.dirname(directory);
    }
    return undefined;
  };
  for (const changedFile of rustChanges) {
    const absolute = path.resolve(root, changedFile);
    if (!absolute.startsWith(`${rootPath}${path.sep}`)) {
      unsupported.push({
        file: changedFile,
        reason: "outside repository root",
      });
      continue;
    }
    if (!existsSync(absolute)) {
      unsupported.push({
        file: changedFile,
        reason: "file is deleted or unavailable",
      });
      continue;
    }
    const owner = packageFor(absolute);
    if (owner === undefined) {
      unsupported.push({ file: changedFile, reason: "no package Cargo.toml" });
      continue;
    }
    const relative = repoRelativePath(owner.cwd, absolute);
    if (relative.startsWith("src/bin/")) {
      unsupported.push({
        file: changedFile,
        reason: "Rust binary tests need an explicit Cargo binary target",
      });
      continue;
    }
    if (relative === "src/main.rs") {
      unsupported.push({
        file: changedFile,
        reason: "Rust main tests need an explicit Cargo binary target",
      });
      continue;
    }
    if (!relative.startsWith("src/")) {
      unsupported.push({
        file: changedFile,
        reason: "non-src Rust targets need an explicit Cargo target selector",
      });
      continue;
    }
    if (owner.unsupported) {
      unsupported.push({ file: changedFile, reason: owner.unsupported });
      continue;
    }
    const module = moduleFor(owner.cwd, absolute);
    if (module === undefined) {
      unsupported.push({
        file: changedFile,
        reason: "cannot derive Rust module",
      });
      continue;
    }
    if (!hasTest(absolute)) {
      unsupported.push({
        file: changedFile,
        reason: `changed file has no test in module ${module || "<crate>"}`,
      });
      continue;
    }
    const key = `${owner.cwd}\0${module}`;
    targets.set(key, {
      file: changedFile,
      cwd: owner.cwd,
      crate: owner.crate,
      module,
    });
  }
  const selected = [...targets.values()];
  return {
    targets: selected.filter(
      (target) =>
        !selected.some(
          (other) =>
            target.cwd === other.cwd &&
            target.module !== other.module &&
            (other.module === "" ||
              target.module.startsWith(`${other.module}::`)),
        ),
    ),
    unsupported,
  };
};
