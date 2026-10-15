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

const hasTest = (file: string) =>
  /#\s*\[(?:[\w:]+::)?test\s*\]/u.test(readFileSync(file, "utf-8"));

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
  const packages = new Map<string, { cwd: string; crate: string } | null>();
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
          const result = { cwd: directory, crate: pkg.name };
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
    if (!relative.startsWith("src/")) {
      unsupported.push({
        file: changedFile,
        reason: "non-src Rust targets need an explicit Cargo target selector",
      });
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
