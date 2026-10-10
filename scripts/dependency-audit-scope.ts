import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

export type DependencyChanges = {
  added: string[];
  changed: string[];
  removed: string[];
};

const packageName = (resolution: string): string => {
  const separator = resolution.lastIndexOf("@");
  return separator > 0 ? resolution.slice(0, separator) : resolution;
};

const resolutions = (text: string): Map<string, string[]> => {
  const parsed: unknown = Bun.JSONC.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    return panic("bun.lock must contain an object");
  }
  const packages = "packages" in parsed ? parsed.packages : undefined;
  if (
    typeof packages !== "object" ||
    packages === null ||
    Array.isArray(packages)
  ) {
    return panic('bun.lock must contain a "packages" object');
  }
  const grouped = new Map<string, string[]>();
  for (const value of Object.values(packages)) {
    if (!Array.isArray(value) || typeof value.at(0) !== "string") {
      continue;
    }
    const resolution = value.at(0);
    const name = packageName(resolution);
    const entries = grouped.get(name) ?? [];
    entries.push(resolution);
    grouped.set(name, entries);
  }
  for (const entries of grouped.values()) {
    entries.sort(compareCodeUnit);
  }
  return grouped;
};

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const dependencyChanges = (
  baseLockfile: string,
  headLockfile: string,
): DependencyChanges => {
  const base = resolutions(baseLockfile);
  const head = resolutions(headLockfile);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of names) {
    const before = base.get(name);
    const after = head.get(name);
    if (before === undefined) {
      added.push(name);
    } else if (after === undefined) {
      removed.push(name);
    } else if (!same(before, after)) {
      changed.push(name);
    }
  }
  return {
    added: added.toSorted(compareCodeUnit),
    changed: changed.toSorted(compareCodeUnit),
    removed: removed.toSorted(compareCodeUnit),
  };
};

export const auditablePackages = ({
  added,
  changed,
}: DependencyChanges): Set<string> => new Set([...added, ...changed]);
