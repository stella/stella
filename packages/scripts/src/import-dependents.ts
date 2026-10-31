import { Result } from "better-result";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isPathInside } from "@stll/portable-path";

import { parseSource } from "./syntax-tree";

const QUOTED_SPECIFIER = /^(["'`])(?<specifier>[^"'`]*)\1$/u;
const REPOSITORY_SPECIFIER = /^(?:\.|\/|@\/|~\/)/u;

type ImportDependentsOptions = {
  repositoryRoot: string;
  /** Absolute paths of every module that may import a changed one. */
  candidates: readonly string[];
  /** Absolute paths of the changed modules. */
  changed: readonly string[];
};

/**
 * The candidates that import a changed module, directly or through other
 * candidates, in the form the caller passed them.
 *
 * Types flow through inference: when a changed function starts returning a
 * Result, an unchanged wrapper that returns its value does too, so the
 * wrapper's callers are affected without importing the changed module. The
 * closure is therefore transitive over every import, type-only included.
 *
 * A repository specifier (relative or a path alias) that does not resolve
 * makes its importer dependent, and that importer's own importers with it:
 * the edge cannot be ruled out, and the check this feeds must not skip a
 * module on a resolution miss.
 */
export const importDependents = ({
  repositoryRoot,
  candidates,
  changed,
}: ImportDependentsOptions): Set<string> => {
  // Resolution yields real paths, so every input is compared in that form; a
  // root reached through a symlink would otherwise match nothing.
  const root = realpathSync(repositoryRoot);
  const callerPath = new Map(
    candidates.map((file) => [realpathSync(file), file]),
  );
  const importers = new Map<string, string[]>();
  const seeds = changed.map((file) => realpathSync(file));
  const resolutions = new Map<string, string | undefined>();

  const resolve = (importer: string, specifier: string) => {
    const directory = path.dirname(importer);
    const key = `${directory}\0${specifier}`;
    if (resolutions.has(key)) {
      return resolutions.get(key);
    }
    const resolved = Result.try(() =>
      realpathSync(Bun.resolveSync(specifier, directory)),
    );
    const target = resolved.isOk() ? resolved.value : undefined;
    resolutions.set(key, target);
    return target;
  };

  for (const importer of callerPath.keys()) {
    const source = parseSource(importer, readFileSync(importer, "utf-8"));
    const specifiers = [
      ...source.module.staticImports.map(
        ({ moduleRequest }) => moduleRequest.value,
      ),
      ...source.module.staticExports.flatMap(({ entries }) =>
        entries.flatMap(({ moduleRequest }) =>
          moduleRequest === null ? [] : [moduleRequest.value],
        ),
      ),
      ...source.module.dynamicImports.flatMap(({ moduleRequest }) => {
        const text = source.sourceText.slice(
          moduleRequest.start,
          moduleRequest.end,
        );
        const specifier = QUOTED_SPECIFIER.exec(text)?.groups?.["specifier"];
        return specifier === undefined ? [] : [specifier];
      }),
    ];
    for (const specifier of specifiers) {
      const target = resolve(importer, specifier);
      if (target === undefined) {
        if (REPOSITORY_SPECIFIER.test(specifier)) {
          seeds.push(importer);
        }
        continue;
      }
      if (
        !isPathInside(root, target) ||
        target.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        continue;
      }
      const list = importers.get(target) ?? [];
      list.push(importer);
      importers.set(target, list);
    }
  }

  const changedSet = new Set(changed.map((file) => realpathSync(file)));
  const reached = new Set(seeds);
  const pending = [...seeds];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const importer of importers.get(next) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer);
        pending.push(importer);
      }
    }
  }
  const dependents = new Set<string>();
  for (const file of reached) {
    const original = callerPath.get(file);
    if (original !== undefined && !changedSet.has(file)) {
      dependents.add(original);
    }
  }
  return dependents;
};
