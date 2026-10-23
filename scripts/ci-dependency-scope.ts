import { spawnSync } from "node:child_process";

import {
  type Lockfile,
  parseLockfile,
  workspaceClosure,
} from "./landing-deploy-scope";

export type DependencyScope =
  | { type: "none"; files: readonly string[] }
  | { type: "dev-tooling"; files: readonly string[] }
  | { type: "runtime"; files: readonly string[] }
  | { type: "shared-base"; files: readonly string[] }
  | { type: "unknown"; files: readonly string[] };

type JsonRecord = Record<string, unknown>;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const SHARED_BASE_FILES = new Set([
  ".node-version",
  "bunfig.toml",
  "stll-toolchain.json",
]);
const DEV_TOOL = /^(?:@stll\/oxlint-|@types\/|oxlint$|typescript$|knip$)/u;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readAt = (revision: string, file: string): string | undefined => {
  const result = spawnSync("git", ["show", `${revision}:${file}`], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout : undefined;
};

const parseAt = (revision: string, file: string): unknown => {
  const source = readAt(revision, file);
  return source === undefined ? undefined : Bun.JSONC.parse(source);
};

const packageName = (ident: unknown): string | undefined => {
  if (typeof ident !== "string") {
    return undefined;
  }
  const end = ident.lastIndexOf("@");
  return end > 0 ? ident.slice(0, end) : undefined;
};

const changedPackageNames = (before: Lockfile, after: Lockfile) => {
  const names = new Set<string>();
  for (const key of new Set([
    ...Object.keys(before.packages),
    ...Object.keys(after.packages),
  ])) {
    if (
      JSON.stringify(before.packages[key]) ===
      JSON.stringify(after.packages[key])
    ) {
      continue;
    }
    const name = packageName(
      after.packages[key]?.at(0) ?? before.packages[key]?.at(0),
    );
    if (name === undefined) {
      return undefined;
    }
    names.add(name);
  }
  return names;
};

const manifestDependencies = (manifest: JsonRecord) =>
  new Set(
    DEPENDENCY_FIELDS.flatMap((field) => {
      const value = manifest[field];
      return isRecord(value) ? Object.keys(value) : [];
    }),
  );

const manifestChangedKeys = (before: JsonRecord, after: JsonRecord) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );

const allFiles = (changed: readonly string[]) => [...changed];

// Any input the classification cannot read selects every job.
const unknownScope = (
  changed: readonly string[],
  reason: string,
): DependencyScope => {
  console.error(
    `Dependency scope unavailable (${reason}); selecting every job`,
  );
  return { type: "unknown", files: allFiles(changed) };
};

// ci-plan runs this before installing dependencies, so only Bun and Node
// built-ins are available; an unparseable file reads as absent.
const parseOrUndefined = (revision: string, file: string): unknown => {
  try {
    return parseAt(revision, file);
  } catch {
    return undefined;
  }
};

const changedDevDependencies = (before: JsonRecord, after: JsonRecord) => {
  const oldDev = isRecord(before["devDependencies"])
    ? before["devDependencies"]
    : {};
  const newDev = isRecord(after["devDependencies"])
    ? after["devDependencies"]
    : {};
  return [...new Set([...Object.keys(oldDev), ...Object.keys(newDev)])].filter(
    (name) => JSON.stringify(oldDev[name]) !== JSON.stringify(newDev[name]),
  );
};

/** Whether every workspace manifest change is a dev-tool dependency change; undefined when one is unreadable. */
const manifestsDevOnly = (
  base: string,
  head: string,
  manifests: readonly string[],
): boolean | undefined => {
  let devOnly = true;
  for (const file of manifests) {
    const oldSource = readAt(base, file);
    const newSource = readAt(head, file);
    // An added or removed workspace is a runtime change to that directory.
    if (oldSource === undefined || newSource === undefined) {
      devOnly = false;
      continue;
    }
    const oldManifest = parseOrUndefined(base, file);
    const newManifest = parseOrUndefined(head, file);
    if (!isRecord(oldManifest) || !isRecord(newManifest)) {
      return undefined;
    }
    if (
      manifestChangedKeys(oldManifest, newManifest).some(
        (key) => key !== "devDependencies",
      ) ||
      changedDevDependencies(oldManifest, newManifest).some(
        (name) => !DEV_TOOL.test(name),
      )
    ) {
      devOnly = false;
    }
  }
  return devOnly;
};

/**
 * Whether every lockfile workspace dependency edge that changed is a dev-tool
 * dev dependency. A workspace can switch to another version already present in
 * the lockfile without any package record changing, so package records alone
 * cannot prove a tooling-only change.
 */
const workspaceEdgesDevOnly = (before: Lockfile, after: Lockfile): boolean => {
  const directories = new Set([
    ...Object.keys(before.workspaces),
    ...Object.keys(after.workspaces),
  ]);
  for (const directory of directories) {
    const oldWorkspace = before.workspaces[directory];
    const newWorkspace = after.workspaces[directory];
    if (oldWorkspace === undefined || newWorkspace === undefined) {
      return false;
    }
    for (const key of manifestChangedKeys(oldWorkspace, newWorkspace)) {
      if (key !== "devDependencies") {
        return false;
      }
    }
    if (
      changedDevDependencies(oldWorkspace, newWorkspace).some(
        (name) => !DEV_TOOL.test(name),
      )
    ) {
      return false;
    }
  }
  return true;
};

/** Workspaces whose resolved closure changed, plus every consumer; undefined when a workspace has no name. */
const affectedWorkspaces = (
  before: Lockfile,
  after: Lockfile,
  manifests: readonly string[],
): Set<string> | undefined => {
  const affected = new Set<string>();
  const fingerprint = (lock: Lockfile, keys: ReadonlySet<string>) =>
    JSON.stringify(
      [...keys].toSorted().map((key) => [key, lock.packages[key]]),
    );
  for (const [directory, workspace] of Object.entries(after.workspaces)) {
    const name = workspace["name"];
    if (typeof name !== "string") {
      return undefined;
    }
    const oldClosure = workspaceClosure(before, name);
    const newClosure = workspaceClosure(after, name);
    if (
      oldClosure === undefined ||
      newClosure === undefined ||
      // A changed edge can resolve to packages that stay reachable elsewhere,
      // leaving the closure's package records unchanged.
      JSON.stringify(before.workspaces[directory]) !==
        JSON.stringify(workspace) ||
      fingerprint(before, oldClosure.packageKeys) !==
        fingerprint(after, newClosure.packageKeys)
    ) {
      affected.add(directory);
    }
  }
  for (const file of manifests) {
    const directory = file.slice(0, -"/package.json".length);
    // Only workspaces become synthetic source paths; another manifest (a
    // fixture or standalone tool) keeps its own path in the scope list.
    if (Object.hasOwn(after.workspaces, directory)) {
      affected.add(directory);
    }
  }
  // A source change in each affected workspace reaches consumers through the
  // existing selectors; include them explicitly for selectors whose package
  // graph is not available at planning time.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [directory, workspace] of Object.entries(after.workspaces)) {
      if (affected.has(directory)) {
        continue;
      }
      const dependencies = manifestDependencies(workspace);
      const consumesAffected = [...affected].some((target) => {
        const name = after.workspaces[target]?.["name"];
        return typeof name === "string" && dependencies.has(name);
      });
      if (consumesAffected) {
        affected.add(directory);
        grew = true;
      }
    }
  }
  return affected;
};

export const dependencyScope = ({
  base,
  head,
  changed,
}: {
  base: string;
  head: string;
  changed: readonly string[];
}): DependencyScope => {
  const dependencyFiles = changed.filter(
    (file) =>
      file === "bun.lock" ||
      file.endsWith("/package.json") ||
      file === "package.json",
  );
  if (dependencyFiles.length === 0) {
    return { type: "none", files: allFiles(changed) };
  }
  if (changed.some((file) => SHARED_BASE_FILES.has(file))) {
    return { type: "shared-base", files: allFiles(changed) };
  }
  const beforeRoot = parseOrUndefined(base, "package.json");
  const afterRoot = parseOrUndefined(head, "package.json");
  if (!isRecord(beforeRoot) || !isRecord(afterRoot)) {
    return unknownScope(changed, "root package.json is unreadable");
  }
  if (
    dependencyFiles.includes("package.json") &&
    manifestChangedKeys(beforeRoot, afterRoot).some(
      (key) => key !== "devDependencies",
    )
  ) {
    return { type: "shared-base", files: allFiles(changed) };
  }
  const beforeLock = parseOrUndefined(base, "bun.lock");
  const afterLock = parseOrUndefined(head, "bun.lock");
  // Only package records and workspace edges are classified below; any other
  // lockfile change (overrides, patched dependencies, trusted dependencies,
  // format version) reaches every workspace.
  if (
    isRecord(beforeLock) &&
    isRecord(afterLock) &&
    manifestChangedKeys(beforeLock, afterLock).some(
      (key) => key !== "packages" && key !== "workspaces",
    )
  ) {
    return { type: "shared-base", files: allFiles(changed) };
  }
  const before = parseLockfile(beforeLock);
  const after = parseLockfile(afterLock);
  if (before === undefined || after === undefined) {
    return unknownScope(changed, "bun.lock is unreadable");
  }
  const changedNames = changedPackageNames(before, after);
  if (changedNames === undefined) {
    return unknownScope(changed, "a changed lock package has no identity");
  }
  const manifests = dependencyFiles.filter((file) =>
    file.endsWith("/package.json"),
  );
  const manifestsDev = manifestsDevOnly(base, head, manifests);
  if (manifestsDev === undefined) {
    return unknownScope(changed, "a workspace manifest is unreadable");
  }
  const ordinary = changed.filter(
    (file) =>
      !dependencyFiles.includes(file) ||
      (file.endsWith("/package.json") &&
        !Object.hasOwn(
          after.workspaces,
          file.slice(0, -"/package.json".length),
        )),
  );
  // Dev tooling changes only what lint and type checks read; the plan keeps
  // package checks on and selects tests for the PR's other files alone.
  const rootDevOnly = changedDevDependencies(beforeRoot, afterRoot).every(
    (name) => DEV_TOOL.test(name),
  );
  // A root manifest change reaches every workspace and has no source path a
  // selector could match: only a tooling-only change may narrow it.
  if (dependencyFiles.includes("package.json") && !rootDevOnly) {
    return { type: "shared-base", files: allFiles(changed) };
  }
  if (
    manifestsDev &&
    rootDevOnly &&
    workspaceEdgesDevOnly(before, after) &&
    [...changedNames].every((name) => DEV_TOOL.test(name))
  ) {
    return { type: "dev-tooling", files: ordinary };
  }
  const affected = affectedWorkspaces(before, after, manifests);
  if (affected === undefined) {
    return unknownScope(changed, "a workspace has no package name");
  }
  // The root workspace has no source directory a selector could match, so a
  // runtime change to its closure reaches everything.
  if (affected.has("") || affected.has(".")) {
    return { type: "shared-base", files: allFiles(changed) };
  }
  return {
    type: "runtime",
    files: [
      ...ordinary,
      ...[...affected]
        .toSorted()
        .map((directory) => `${directory}/src/__dependency_scope__.ts`),
    ],
  };
};

if (import.meta.main) {
  const [base, head, ...changed] = process.argv.slice(2);
  if (base === undefined || head === undefined) {
    process.exit(2);
  }
  console.log(JSON.stringify(dependencyScope({ base, head, changed })));
}
