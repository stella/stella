#!/usr/bin/env bun

// Decides whether a range of commits changes anything a deployed workspace
// package's build reads, so a push to main that cannot change the deployed
// site does not start a deploy. The landing and the Outlook add-in use it.
//
//   bun scripts/landing-deploy-scope.ts --package <name> --base <rev> [--head <rev>]
//
// Prints `true` when the package is affected and `false` when it is not, with
// the reason on stderr. The package's build reads:
//   - its own workspace and every workspace it depends on, transitively, as
//     the lockfile's workspace graph records them;
//   - the external packages that graph resolves to, so a lockfile change
//     counts only when it moves one of them;
//   - the files turbo.json declares as `$TURBO_ROOT$` inputs of
//     `<name>#build`, which is where a new read from outside the workspace
//     graph has to be declared.
// Anything the check cannot resolve counts as affected, and a command without
// `--package` fails. The script imports nothing outside the runtime so it runs
// before an install.

export const LANDING_PACKAGE = "@stll/landing";
const TURBO_CONFIG = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";
const RECURSIVE_GLOB_SUFFIX = "/**";
const LOCKFILE = "bun.lock";
const ROOT_MANIFEST = "package.json";
const PATCH_DIRECTORY = "patches/";
const WORKSPACE_PROTOCOL = "@workspace:";
const EMPTY_REVISION = /^0+$/u;
// Install settings that apply to every package; any edit counts.
const INSTALL_SETTINGS = new Set(["bunfig.toml", ".npmrc"]);
const WORKSPACE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type JsonRecord = Record<string, unknown>;

export type Lockfile = {
  readonly workspaces: Readonly<Record<string, JsonRecord>>;
  readonly packages: Readonly<Record<string, readonly unknown[]>>;
  readonly patchedDependencies?: Readonly<Record<string, string>>;
  readonly trustedDependencies?: readonly string[];
};

export type Decision =
  | { readonly affected: true; readonly reason: string }
  | { readonly affected: false; readonly reason: string };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dependencyNames = (
  record: JsonRecord,
  fields: readonly string[],
): readonly string[] =>
  fields.flatMap((field) => {
    const declared = record[field];
    return isRecord(declared) ? Object.keys(declared) : [];
  });

const workspaceDirectory = (entry: readonly unknown[]): string | undefined => {
  const ident = entry[0];
  if (typeof ident !== "string") {
    return undefined;
  }
  const marker = ident.lastIndexOf(WORKSPACE_PROTOCOL);
  return marker === -1
    ? undefined
    : ident.slice(marker + WORKSPACE_PROTOCOL.length);
};

/**
 * Bun keys a package installed below another as `parent/child`, so a
 * dependency resolves from the nearest enclosing key, as Node's module
 * resolution would find it.
 */
const resolveKey = (
  lock: Lockfile,
  parent: readonly string[],
  dependency: string,
): readonly string[] | undefined => {
  for (let depth = parent.length; depth >= 0; depth -= 1) {
    const path = [...parent.slice(0, depth), dependency];
    if (path.join("/") in lock.packages) {
      return path;
    }
  }
  return undefined;
};

export type WorkspaceClosure = {
  /** Workspace directories the package builds from, its own included. */
  readonly workspaceDirectories: ReadonlySet<string>;
  /** Lockfile package keys the package's graph resolves to. */
  readonly packageKeys: ReadonlySet<string>;
};

export const workspaceClosure = (
  lock: Lockfile,
  workspaceName: string,
): WorkspaceClosure | undefined => {
  const startingWorkspace = Object.entries(lock.workspaces).find(
    ([, workspace]) => workspace["name"] === workspaceName,
  );
  if (startingWorkspace === undefined) {
    return undefined;
  }
  const workspaceDirectories = new Set<string>([startingWorkspace[0]]);
  const packageKeys = new Set<string>();
  const queue: {
    readonly path: readonly string[];
    readonly dependencies: readonly string[];
  }[] = [
    {
      path: [workspaceName],
      dependencies: dependencyNames(
        startingWorkspace[1],
        WORKSPACE_DEPENDENCY_FIELDS,
      ),
    },
  ];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const dependency of next.dependencies) {
      const path = resolveKey(lock, next.path, dependency);
      if (path === undefined) {
        // An optional or peer dependency the install left out.
        continue;
      }
      const key = path.join("/");
      if (packageKeys.has(key)) {
        continue;
      }
      packageKeys.add(key);
      const entry = lock.packages[key] ?? [];
      const directory = workspaceDirectory(entry);
      if (directory !== undefined) {
        workspaceDirectories.add(directory);
        const workspace = lock.workspaces[directory];
        if (workspace !== undefined) {
          queue.push({
            path,
            dependencies: dependencyNames(
              workspace,
              WORKSPACE_DEPENDENCY_FIELDS,
            ),
          });
        }
        continue;
      }
      const metadata = entry.find(isRecord);
      if (metadata !== undefined) {
        queue.push({
          path,
          dependencies: dependencyNames(metadata, PACKAGE_DEPENDENCY_FIELDS),
        });
      }
    }
  }
  return { workspaceDirectories, packageKeys };
};

/**
 * Everything the install gives the package: its workspace manifests, every
 * resolved package with its version and integrity, and the patches and
 * install-script trust that apply to those packages. `patchContents` returns
 * the text of a patch file at the same revision as the lockfile.
 */
export const installFingerprint = ({
  lock,
  packageName,
  packageManager,
  patchContents,
}: {
  readonly lock: Lockfile;
  readonly packageName: string;
  readonly packageManager: unknown;
  readonly patchContents: (patchPath: string) => string | undefined;
}): string | undefined => {
  const closure = workspaceClosure(lock, packageName);
  if (closure === undefined) {
    return undefined;
  }
  const idents = new Set<string>();
  const names = new Set<string>();
  const packages: [string, unknown][] = [];
  for (const key of [...closure.packageKeys].toSorted()) {
    const entry = lock.packages[key] ?? [];
    packages.push([key, entry]);
    const ident = entry[0];
    if (typeof ident === "string") {
      idents.add(ident);
      names.add(ident.slice(0, ident.lastIndexOf("@")));
    }
  }
  const patches = Object.entries(lock.patchedDependencies ?? {})
    .filter(([ident]) => idents.has(ident))
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([ident, patchPath]) => [ident, patchPath, patchContents(patchPath)]);
  return JSON.stringify({
    packageManager,
    workspaces: [...closure.workspaceDirectories]
      .toSorted()
      .map((directory) => [directory, lock.workspaces[directory]]),
    packages,
    patches,
    trusted: (lock.trustedDependencies ?? [])
      .filter((name) => names.has(name))
      .toSorted(),
  });
};

/** Turbo inputs here are an exact path or a `dir/**` subtree. */
export const matchesRootInput = (file: string, input: string): boolean => {
  if (!input.endsWith(RECURSIVE_GLOB_SUFFIX)) {
    return file === input;
  }
  const directory = input.slice(0, -RECURSIVE_GLOB_SUFFIX.length);
  return file.startsWith(`${directory}/`);
};

const buildTask = (packageName: string) => `${packageName}#build`;

export const buildRootInputs = (
  turboConfig: unknown,
  packageName: string,
): readonly string[] => {
  const tasks = isRecord(turboConfig) ? turboConfig["tasks"] : undefined;
  const task = isRecord(tasks) ? tasks[buildTask(packageName)] : undefined;
  const inputs = isRecord(task) ? task["inputs"] : undefined;
  if (!Array.isArray(inputs)) {
    return [];
  }
  return inputs
    .filter(
      (input): input is string =>
        typeof input === "string" && input.startsWith(TURBO_ROOT_INPUT_PREFIX),
    )
    .map((input) => input.slice(TURBO_ROOT_INPUT_PREFIX.length));
};

const isInstallInput = (file: string): boolean =>
  file === LOCKFILE ||
  file === ROOT_MANIFEST ||
  file.startsWith(PATCH_DIRECTORY);

export type Revision = {
  readonly lock: Lockfile | undefined;
  readonly packageManager: unknown;
  readonly patchContents: (patchPath: string) => string | undefined;
};

export const decide = ({
  packageName,
  changedFiles,
  rootInputs,
  base,
  head,
}: {
  readonly packageName: string;
  readonly changedFiles: readonly string[];
  readonly rootInputs: readonly string[];
  readonly base: Revision;
  readonly head: Revision;
}): Decision => {
  const baseClosure = base.lock && workspaceClosure(base.lock, packageName);
  const headClosure = head.lock && workspaceClosure(head.lock, packageName);
  if (baseClosure === undefined || headClosure === undefined) {
    return {
      affected: true,
      reason: `the ${packageName} workspace graph is unknown`,
    };
  }
  const directories = new Set([
    ...baseClosure.workspaceDirectories,
    ...headClosure.workspaceDirectories,
  ]);
  let installChanged = false;
  for (const file of changedFiles) {
    for (const directory of directories) {
      if (file.startsWith(`${directory}/`)) {
        return { affected: true, reason: `${file} is in ${directory}` };
      }
    }
    const input = rootInputs.find((candidate) =>
      matchesRootInput(file, candidate),
    );
    if (input !== undefined) {
      return {
        affected: true,
        reason: `${file} is a declared input of ${buildTask(packageName)}`,
      };
    }
    if (INSTALL_SETTINGS.has(file)) {
      return { affected: true, reason: `${file} changes every install` };
    }
    installChanged ||= isInstallInput(file);
  }
  if (!installChanged) {
    return { affected: false, reason: `no ${packageName} input changed` };
  }
  const before =
    base.lock && installFingerprint({ ...base, lock: base.lock, packageName });
  const after =
    head.lock && installFingerprint({ ...head, lock: head.lock, packageName });
  return before === after
    ? {
        affected: false,
        reason: `the resolved packages of ${packageName} are unchanged`,
      }
    : {
        affected: true,
        reason: `the resolved packages of ${packageName} changed`,
      };
};

const git = (args: readonly string[]): string | undefined => {
  const result = Bun.spawnSync(["git", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
};

const showFile = (revision: string, file: string): string | undefined =>
  git(["show", `${revision}:${file}`]);

const parseJsonc = (text: string | undefined): unknown =>
  text === undefined ? undefined : Bun.JSONC.parse(text);

export const parseLockfile = (value: unknown): Lockfile | undefined => {
  if (
    !isRecord(value) ||
    !isRecord(value["workspaces"]) ||
    !isRecord(value["packages"])
  ) {
    return undefined;
  }
  const workspaces: Record<string, JsonRecord> = {};
  for (const [directory, workspace] of Object.entries(value["workspaces"])) {
    if (isRecord(workspace)) {
      workspaces[directory] = workspace;
    }
  }
  const packages: Record<string, readonly unknown[]> = {};
  for (const [key, entry] of Object.entries(value["packages"])) {
    if (Array.isArray(entry)) {
      packages[key] = entry;
    }
  }
  const patchedDependencies: Record<string, string> = {};
  const patched = value["patchedDependencies"];
  for (const [ident, patchPath] of Object.entries(
    isRecord(patched) ? patched : {},
  )) {
    if (typeof patchPath === "string") {
      patchedDependencies[ident] = patchPath;
    }
  }
  const trusted = value["trustedDependencies"];
  return {
    workspaces,
    packages,
    patchedDependencies,
    trustedDependencies: Array.isArray(trusted)
      ? trusted.filter((name): name is string => typeof name === "string")
      : [],
  };
};

const readRevision = (revision: string): Revision => {
  const manifest = parseJsonc(showFile(revision, ROOT_MANIFEST));
  return {
    lock: parseLockfile(parseJsonc(showFile(revision, LOCKFILE))),
    packageManager: isRecord(manifest) ? manifest["packageManager"] : undefined,
    patchContents: (patchPath) => showFile(revision, patchPath),
  };
};

const readArgument = (
  args: readonly string[],
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

export type DeployRange = { readonly base: string; readonly head: string };

type DeployScope = DeployRange & { readonly packageName: string };

const resolveDecision = ({
  packageName,
  base,
  head,
}: DeployScope): Decision => {
  if (base === "" || EMPTY_REVISION.test(base)) {
    return { affected: true, reason: "there is no base revision to compare" };
  }
  // Without rename detection a moved file lists both paths, so a file moved
  // out of a package input still counts.
  const changed = git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    head,
    "--",
  ]);
  if (changed === undefined) {
    return { affected: true, reason: `cannot compare ${base} with ${head}` };
  }
  return decide({
    packageName,
    changedFiles: changed.split("\0").filter((file) => file !== ""),
    rootInputs: buildRootInputs(
      parseJsonc(showFile(head, TURBO_CONFIG)),
      packageName,
    ),
    base: readRevision(base),
    head: readRevision(head),
  });
};

export const deployAffected = (scope: DeployScope): boolean => {
  const decision = resolveDecision(scope);
  console.error(
    `${scope.packageName} ${decision.affected ? "affected" : "unaffected"}: ${decision.reason}`,
  );
  return decision.affected;
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const packageName = readArgument(args, "--package");
  if (packageName === undefined || packageName === "") {
    console.error("usage: --package <name> --base <rev> [--head <rev>]");
    process.exit(2);
  }
  console.log(
    String(
      deployAffected({
        packageName,
        base: readArgument(args, "--base") ?? "",
        head: readArgument(args, "--head") ?? "HEAD",
      }),
    ),
  );
}
