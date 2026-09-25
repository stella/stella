import { panic } from "better-result";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

const APP_BOUNDARY_LEDGER_PATH = "scripts/app-boundary-exceptions.json";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const SOURCE_FILE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const SKIPPED_SCAN_DIRS = new Set([
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const LEDGER_EDGE_FIELDS = new Set(["kind", "source", "specifier", "target"]);
const NO_TYPESCRIPT_INPUTS_DIAGNOSTIC_CODE = 18_003;

type AppBoundaryEdgeKind =
  | "manifest-dependency"
  | "source-import"
  | "tsconfig-include"
  | "tsconfig-path";

export type AppBoundaryEdge = {
  kind: AppBoundaryEdgeKind;
  source: string;
  specifier: string;
  target: string;
};

export type AppBoundaryIssue = {
  message: string;
  path: string;
};

type Workspace = {
  directory: string;
  name: string;
  path: string;
};

type PathAlias = {
  pattern: string;
  targets: string[];
};

type AppBoundaryCollection = {
  edges: AppBoundaryEdge[];
  issues: AppBoundaryIssue[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toPosixPath = (filePath: string) => filePath.replaceAll(path.sep, "/");

const findFiles = (directoryPath: string): string[] => {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_SCAN_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...findFiles(path.join(directoryPath, entry.name)));
      continue;
    }

    const filePath = path.join(directoryPath, entry.name);
    if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
};

const listRepositoryFiles = (rootDir: string): string[] | null => {
  try {
    const output = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "apps",
        "packages",
      ],
      { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split("\n")
      .filter((filePath) => filePath !== "")
      .map((filePath) => path.resolve(rootDir, filePath))
      .filter((filePath) => existsSync(filePath));
  } catch {
    return null;
  }
};

const readJson = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
};

const readWorkspaces = (rootDir: string): Workspace[] =>
  ["apps", "packages"].flatMap((parentDirectory) => {
    const parentPath = path.resolve(rootDir, parentDirectory);
    if (!existsSync(parentPath)) {
      return [];
    }

    return readdirSync(parentPath, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        return [];
      }
      const workspacePath = path.join(parentPath, entry.name);
      const packageJson = readJson(path.join(workspacePath, "package.json"));
      const name = isRecord(packageJson) ? packageJson["name"] : undefined;
      return typeof name === "string"
        ? [
            {
              directory: `${parentDirectory}/${entry.name}`,
              name,
              path: workspacePath,
            },
          ]
        : [];
    });
  });

const appForPath = (
  absolutePath: string,
  apps: readonly Workspace[],
): Workspace | null =>
  apps.find(
    (app) =>
      absolutePath === app.path ||
      absolutePath.startsWith(`${app.path}${path.sep}`),
  ) ?? null;

const appForPackageSpecifier = (
  specifier: string,
  apps: readonly Workspace[],
): Workspace | null =>
  apps.find(
    ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
  ) ?? null;

const wildcardMatch = (pattern: string, specifier: string): string | null => {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) {
    return pattern === specifier ? "" : null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
};

const appForAlias = (
  specifier: string,
  aliases: readonly PathAlias[],
  apps: readonly Workspace[],
): Workspace | null => {
  const mostSpecificAliases = aliases.toSorted(
    (a, b) =>
      b.pattern.replaceAll("*", "").length -
      a.pattern.replaceAll("*", "").length,
  );
  for (const { pattern, targets } of mostSpecificAliases) {
    const wildcard = wildcardMatch(pattern, specifier);
    if (wildcard === null) {
      continue;
    }
    for (const target of targets) {
      const resolvedTarget = target.includes("*")
        ? target.replaceAll("*", () => wildcard)
        : target;
      const app = appForPath(resolvedTarget, apps);
      if (app !== null) {
        return app;
      }
    }
  }
  return null;
};

const readDependencyNames = (packageJson: unknown): string[] => {
  if (!isRecord(packageJson)) {
    return [];
  }
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies)) {
      names.add(name);
    }
  }
  return [...names];
};

const readTsconfig = (
  tsconfigPath: string,
): { aliases: PathAlias[]; diagnostics: string[]; includes: string[] } => {
  const unrecoverableDiagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        unrecoverableDiagnostics.push(diagnostic);
      },
    },
  );
  const diagnostics = withoutTsgoOnlyOptionDiagnostics([
    ...unrecoverableDiagnostics,
    ...(parsed?.errors ?? []),
  ])
    .filter(({ code }) => code !== NO_TYPESCRIPT_INPUTS_DIAGNOSTIC_CODE)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )
    .filter((message, index, messages) => messages.indexOf(message) === index);
  if (parsed === undefined || diagnostics.length > 0) {
    return {
      aliases: [],
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : ["TypeScript could not parse this configuration"],
      includes: [],
    };
  }

  const paths = parsed.options.paths ?? {};
  const pathsBasePath =
    "pathsBasePath" in parsed.options &&
    typeof parsed.options["pathsBasePath"] === "string"
      ? parsed.options["pathsBasePath"]
      : null;
  const baseDirectory = pathsBasePath ?? path.dirname(tsconfigPath);
  const aliases = Object.entries(paths).flatMap(([pattern, targets]) => {
    const resolvedTargets = targets.map((target) =>
      path.resolve(baseDirectory, target),
    );
    return resolvedTargets.length === 0
      ? []
      : [{ pattern, targets: resolvedTargets }];
  });
  const raw: unknown = parsed.raw;
  const includes =
    isRecord(raw) && Array.isArray(raw["include"])
      ? raw["include"].filter(
          (include): include is string => typeof include === "string",
        )
      : [];
  return { aliases, diagnostics: [], includes };
};

const edgeKey = (edge: AppBoundaryEdge) =>
  `${edge.kind}\u0000${edge.source}\u0000${edge.specifier}\u0000${edge.target}`;

const collectAppBoundaryResult = (rootDir: string): AppBoundaryCollection => {
  const workspaces = readWorkspaces(rootDir);
  const apps = workspaces.filter(({ directory }) =>
    directory.startsWith("apps/"),
  );
  const repositoryFiles = listRepositoryFiles(rootDir);
  const edges: AppBoundaryEdge[] = [];
  const issues: AppBoundaryIssue[] = [];

  for (const workspace of workspaces) {
    const workspaceFiles =
      repositoryFiles?.filter((filePath) =>
        filePath.startsWith(`${workspace.path}${path.sep}`),
      ) ?? findFiles(workspace.path);
    for (const dependencyName of readDependencyNames(
      readJson(path.join(workspace.path, "package.json")),
    )) {
      const target = appForPackageSpecifier(dependencyName, apps);
      if (target !== null && target.directory !== workspace.directory) {
        edges.push({
          kind: "manifest-dependency",
          source: `${workspace.directory}/package.json`,
          specifier: dependencyName,
          target: target.directory,
        });
      }
    }

    const aliases: PathAlias[] = [];
    for (const tsconfigPath of workspaceFiles.filter(
      (filePath) =>
        path.basename(filePath).startsWith("tsconfig") &&
        filePath.endsWith(".json"),
    )) {
      const config = readTsconfig(tsconfigPath);
      const source = toPosixPath(path.relative(rootDir, tsconfigPath));
      for (const diagnostic of config.diagnostics) {
        issues.push({
          message: `invalid TypeScript configuration: ${diagnostic}`,
          path: source,
        });
      }
      aliases.push(...config.aliases);

      for (const { pattern, targets } of config.aliases) {
        for (const targetPath of targets) {
          const target = appForPath(targetPath.replaceAll("*", ""), apps);
          if (target === null || target.directory === workspace.directory) {
            continue;
          }
          edges.push({
            kind: "tsconfig-path",
            source,
            specifier: `${pattern} -> ${toPosixPath(path.relative(path.dirname(tsconfigPath), targetPath))}`,
            target: target.directory,
          });
        }
      }

      for (const include of config.includes) {
        const target = appForPath(
          path.resolve(path.dirname(tsconfigPath), include.replaceAll("*", "")),
          apps,
        );
        if (target !== null && target.directory !== workspace.directory) {
          edges.push({
            kind: "tsconfig-include",
            source,
            specifier: include,
            target: target.directory,
          });
        }
      }
    }

    for (const sourcePath of workspaceFiles.filter((filePath) =>
      SOURCE_FILE_EXTENSIONS.has(path.extname(filePath)),
    )) {
      const source = toPosixPath(path.relative(rootDir, sourcePath));
      const importedFiles = ts.preProcessFile(
        readFileSync(sourcePath, "utf-8"),
        true,
        true,
      ).importedFiles;
      for (const { fileName: specifier } of importedFiles) {
        const target =
          appForPackageSpecifier(specifier, apps) ??
          (specifier.startsWith(".")
            ? appForPath(
                path.resolve(path.dirname(sourcePath), specifier),
                apps,
              )
            : null) ??
          appForAlias(specifier, aliases, apps);
        if (target !== null && target.directory !== workspace.directory) {
          edges.push({
            kind: "source-import",
            source,
            specifier,
            target: target.directory,
          });
        }
      }
    }
  }

  return {
    edges: [
      ...new Map(edges.map((edge) => [edgeKey(edge), edge])).values(),
    ].toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    issues,
  };
};

export const collectAppBoundaryEdges = (rootDir: string): AppBoundaryEdge[] =>
  collectAppBoundaryResult(rootDir).edges;

const parseEdgeKind = (value: unknown): AppBoundaryEdgeKind | null => {
  switch (value) {
    case "manifest-dependency":
    case "source-import":
    case "tsconfig-include":
    case "tsconfig-path":
      return value;
    default:
      return null;
  }
};

type ExceptionsReadResult = {
  exceptions: AppBoundaryEdge[];
  issues: AppBoundaryIssue[];
};

const parseExceptions = (
  value: unknown,
  issuePath: string,
): ExceptionsReadResult => {
  if (!Array.isArray(value)) {
    return {
      exceptions: [],
      issues: [
        {
          message: "app-boundary ledger must be a JSON array",
          path: issuePath,
        },
      ],
    };
  }

  const exceptions: AppBoundaryEdge[] = [];
  const issues: AppBoundaryIssue[] = [];
  const seenKeys = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const kind = isRecord(entry) ? parseEdgeKind(entry["kind"]) : null;
    if (
      kind === null ||
      !isRecord(entry) ||
      Object.keys(entry).length !== LEDGER_EDGE_FIELDS.size ||
      Object.keys(entry).some((field) => !LEDGER_EDGE_FIELDS.has(field)) ||
      typeof entry["source"] !== "string" ||
      typeof entry["specifier"] !== "string" ||
      typeof entry["target"] !== "string"
    ) {
      issues.push({
        message:
          "app-boundary exception must define a valid kind, source, specifier, and target",
        path: `${issuePath}:${index + 1}`,
      });
      continue;
    }
    const exception = {
      kind,
      source: entry["source"],
      specifier: entry["specifier"],
      target: entry["target"],
    };
    const key = edgeKey(exception);
    if (seenKeys.has(key)) {
      issues.push({
        message: "app-boundary exception must not be duplicated",
        path: `${issuePath}:${index + 1}`,
      });
      continue;
    }
    seenKeys.add(key);
    exceptions.push(exception);
  }
  return { exceptions, issues };
};

const readExceptions = (rootDir: string): ExceptionsReadResult => {
  const ledgerPath = path.resolve(rootDir, APP_BOUNDARY_LEDGER_PATH);
  if (!existsSync(ledgerPath)) {
    return { exceptions: [], issues: [] };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(ledgerPath, "utf-8"));
  } catch {
    return {
      exceptions: [],
      issues: [
        {
          message: "app-boundary ledger must contain valid JSON",
          path: APP_BOUNDARY_LEDGER_PATH,
        },
      ],
    };
  }
  return parseExceptions(value, APP_BOUNDARY_LEDGER_PATH);
};

/** One Git invocation: its output, its failure, or no Git binary at all. */
type GitRun =
  | { readonly kind: "ok"; readonly stdout: string }
  | {
      readonly kind: "failed";
      readonly exitCode: number | null;
      readonly stderr: string;
    }
  | { readonly kind: "missing-binary" };

export type GitRunner = (
  rootDir: string,
  arguments_: readonly string[],
) => GitRun;

export type AppBoundaryOptions = {
  /** Variables that mark a CI or pull-request run; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly git?: GitRunner;
};

const runGit: GitRunner = (rootDir, arguments_) => {
  const result = spawnSync("git", arguments_, {
    cwd: rootDir,
    encoding: "utf-8",
    // Untranslated diagnostics, so a failure can be told apart by its stderr.
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    return "code" in result.error && result.error.code === "ENOENT"
      ? { kind: "missing-binary" }
      : { kind: "failed", exitCode: null, stderr: result.error.message };
  }
  return result.status === 0
    ? { kind: "ok", stdout: result.stdout.trim() }
    : { kind: "failed", exitCode: result.status, stderr: result.stderr };
};

const CI_MARKERS = ["CI", "GITHUB_ACTIONS", "GITHUB_BASE_REF"] as const;

const isCiContext = (env: Readonly<Record<string, string | undefined>>) =>
  CI_MARKERS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "false";
  });

const baselineIssue = (message: string): ExceptionsReadResult => ({
  exceptions: [],
  issues: [{ message, path: APP_BOUNDARY_LEDGER_PATH }],
});

/** `rev-parse --verify --quiet` exits 1 without output for a ref that does not exist. */
const isAbsentRef = (run: GitRun): boolean =>
  run.kind === "failed" && run.exitCode === 1 && run.stderr.trim() === "";

/**
 * The ledger at the merge base with the main branch, or null when there is no
 * baseline to compare against. A CI or pull-request run always has a
 * checkout, so there every Git failure is an issue. A local run without Git
 * history (a source archive, or a machine without Git) has no baseline; the
 * ledger's absolute rules still apply through the filesystem scan.
 */
const readBaselineExceptions = (
  rootDir: string,
  { env = process.env, git = runGit }: AppBoundaryOptions,
): ExceptionsReadResult | null => {
  const ci = isCiContext(env);
  const probe = git(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  const withoutHistory =
    probe.kind === "missing-binary" ||
    (probe.kind === "failed" &&
      probe.stderr.includes("not a git repository")) ||
    (probe.kind === "ok" && probe.stdout !== "true");
  if (withoutHistory) {
    return ci
      ? baselineIssue(
          "app-boundary ledger baseline requires a Git checkout in CI",
        )
      : null;
  }
  if (probe.kind !== "ok") {
    return baselineIssue(
      "app-boundary ledger baseline could not be read from Git",
    );
  }

  // Actions defines GITHUB_BASE_REF as an empty string outside pull
  // requests; only a non-empty value names a pull request's base.
  const configuredBase = env["GITHUB_BASE_REF"] || undefined;
  const baseCandidates = [
    configuredBase === undefined ? null : `origin/${configuredBase}`,
    "origin/main",
    "main",
  ].filter((candidate): candidate is string => candidate !== null);
  let baseRevision: string | undefined;
  for (const candidate of baseCandidates) {
    const resolved = git(rootDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${candidate}^{commit}`,
    ]);
    if (resolved.kind === "ok") {
      baseRevision = resolved.stdout;
      break;
    }
    if (!isAbsentRef(resolved)) {
      return baselineIssue(
        "app-boundary ledger baseline branch could not be resolved",
      );
    }
  }
  if (baseRevision === undefined) {
    // Outside CI, a checkout without a main ref (single-commit deploy clones,
    // tag checkouts) has no baseline to ratchet against.
    return ci
      ? baselineIssue("app-boundary ledger baseline branch is unavailable")
      : null;
  }

  const mergeBase = git(rootDir, ["merge-base", "HEAD", baseRevision]);
  if (mergeBase.kind !== "ok") {
    return baselineIssue("app-boundary ledger merge base is unavailable");
  }

  // A tree that reads successfully and lists no ledger is the first rollout:
  // it establishes the reviewed debt baseline for every later branch.
  const listed = git(rootDir, [
    "ls-tree",
    "--full-tree",
    mergeBase.stdout,
    "--",
    APP_BOUNDARY_LEDGER_PATH,
  ]);
  if (listed.kind !== "ok") {
    return baselineIssue("base app-boundary ledger could not be read");
  }
  if (listed.stdout === "") {
    return null;
  }

  const baselineText = git(rootDir, [
    "show",
    `${mergeBase.stdout}:${APP_BOUNDARY_LEDGER_PATH}`,
  ]);
  if (baselineText.kind !== "ok") {
    return baselineIssue("base app-boundary ledger could not be read");
  }

  let baselineValue: unknown;
  try {
    baselineValue = JSON.parse(baselineText.stdout);
  } catch {
    return baselineIssue("base app-boundary ledger must contain valid JSON");
  }
  return parseExceptions(baselineValue, APP_BOUNDARY_LEDGER_PATH);
};

const violationMessage = (edge: AppBoundaryEdge): string => {
  switch (edge.kind) {
    case "manifest-dependency":
      return `app workspace dependency ${edge.specifier} targets ${edge.target}; shared code belongs in packages/*`;
    case "source-import":
      return `source import ${edge.specifier} targets ${edge.target}; import shared code from packages/*`;
    case "tsconfig-include":
      return `TypeScript include ${edge.specifier} targets ${edge.target}`;
    case "tsconfig-path":
      return `TypeScript path mapping ${edge.specifier} targets ${edge.target}`;
    default:
      edge.kind satisfies never;
      return panic(`Unhandled kind: ${String(edge.kind)}`);
  }
};

/**
 * This ledger may only shrink. The legal atlas/API exceptions disappear when ingestion owns a package-level data-access
 * boundary. The playground/web locale exception disappears when locale assets
 * have a shared package or generated owner.
 */
export const validateWorkspaceAppBoundaries = (
  rootDir: string,
  options: AppBoundaryOptions = {},
): AppBoundaryIssue[] => {
  const { edges: observed, issues: collectionIssues } =
    collectAppBoundaryResult(rootDir);
  const { exceptions, issues: exceptionIssues } = readExceptions(rootDir);
  const baseline = readBaselineExceptions(rootDir, options);
  const issues = [
    ...collectionIssues,
    ...exceptionIssues,
    ...(baseline?.issues ?? []),
  ];
  const observedKeys = new Set(observed.map(edgeKey));
  const exceptionKeys = new Set(exceptions.map(edgeKey));
  const baselineKeys = new Set(baseline?.exceptions.map(edgeKey));

  if (baseline?.issues.length === 0) {
    for (const edge of exceptions) {
      if (!baselineKeys.has(edgeKey(edge))) {
        issues.push({
          message:
            "new app-boundary exceptions are forbidden; the ledger may only shrink",
          path: `${APP_BOUNDARY_LEDGER_PATH}:${edge.source} -> ${edge.specifier}`,
        });
      }
    }
  }

  for (const edge of observed) {
    if (!exceptionKeys.has(edgeKey(edge))) {
      issues.push({ message: violationMessage(edge), path: edge.source });
    }
  }
  for (const edge of exceptions) {
    if (!observedKeys.has(edgeKey(edge))) {
      issues.push({
        message:
          "stale app-boundary exception; remove it now that the dependency no longer exists",
        path: `${APP_BOUNDARY_LEDGER_PATH}:${edge.source} -> ${edge.specifier}`,
      });
    }
  }
  return issues;
};
