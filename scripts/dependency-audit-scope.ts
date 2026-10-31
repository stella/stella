import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

export type DependencyChanges = {
  added: string[];
  changed: string[];
  removed: string[];
  registry: ReadonlySet<string>;
};

export type ResolutionSource =
  "registry" | "workspace" | "link" | "file" | "git" | "tarball";

const resolutionParts = (resolution: string): [name: string, spec: string] => {
  const separator = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  return separator > 0
    ? [resolution.slice(0, separator), resolution.slice(separator + 1)]
    : [resolution, ""];
};

export const resolutionSource = (resolution: string): ResolutionSource => {
  const [, spec] = resolutionParts(resolution);
  if (spec.startsWith("workspace:")) {
    return "workspace";
  }
  if (spec.startsWith("link:")) {
    return "link";
  }
  if (spec.startsWith("file:")) {
    return "file";
  }
  if (
    spec.startsWith("git+") ||
    spec.startsWith("github:") ||
    spec.startsWith("git@") ||
    /\.git(?:#|$)/u.test(spec)
  ) {
    return "git";
  }
  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return "tarball";
  }
  return "registry";
};

const isRegistryResolution = (resolution: string): boolean => {
  const source = resolutionSource(resolution);
  switch (source) {
    case "registry":
      return true;
    case "workspace":
    case "link":
    case "file":
    case "git":
    case "tarball":
      return false;
    default:
      source satisfies never;
      return panic("unhandled dependency resolution source");
  }
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
    const [name] = resolutionParts(resolution);
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
  const registry = new Set<string>();
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
    const beforeRegistry = before?.filter(isRegistryResolution) ?? [];
    const afterRegistry = after?.filter(isRegistryResolution) ?? [];
    if (
      afterRegistry.some((resolution) => !beforeRegistry.includes(resolution))
    ) {
      registry.add(name);
    }
  }
  return {
    added: added.toSorted(compareCodeUnit),
    changed: changed.toSorted(compareCodeUnit),
    removed: removed.toSorted(compareCodeUnit),
    registry,
  };
};

export const auditablePackages = ({
  added,
  changed,
  registry,
}: DependencyChanges): Set<string> =>
  new Set([...added, ...changed].filter((name) => registry.has(name)));
