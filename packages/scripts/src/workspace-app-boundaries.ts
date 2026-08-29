import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const APP_BOUNDARY_LEDGER_PATH = "scripts/app-boundary-exceptions.json";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const SOURCE_FILE_EXTENSIONS = new Set([
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
      b.pattern.replace("*", "").length - a.pattern.replace("*", "").length,
  );
  for (const { pattern, targets } of mostSpecificAliases) {
    const wildcard = wildcardMatch(pattern, specifier);
    if (wildcard === null) {
      continue;
    }
    for (const target of targets) {
      const resolvedTarget = target.includes("*")
        ? target.replace("*", () => wildcard)
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
): { aliases: PathAlias[]; includes: string[] } => {
  const readResult = ts.readConfigFile(tsconfigPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (readResult.error !== undefined || !isRecord(readResult.config)) {
    return { aliases: [], includes: [] };
  }

  const compilerOptions = isRecord(readResult.config["compilerOptions"])
    ? readResult.config["compilerOptions"]
    : null;
  const paths = isRecord(compilerOptions?.["paths"])
    ? compilerOptions["paths"]
    : {};
  const baseUrl = compilerOptions?.["baseUrl"];
  const baseDirectory =
    typeof baseUrl === "string"
      ? path.resolve(path.dirname(tsconfigPath), baseUrl)
      : path.dirname(tsconfigPath);
  const aliases = Object.entries(paths).flatMap(([pattern, targets]) => {
    if (!Array.isArray(targets)) {
      return [];
    }
    const resolvedTargets = targets.flatMap((target) =>
      typeof target === "string" ? [path.resolve(baseDirectory, target)] : [],
    );
    return resolvedTargets.length === 0
      ? []
      : [{ pattern, targets: resolvedTargets }];
  });
  const includes = Array.isArray(readResult.config["include"])
    ? readResult.config["include"].filter(
        (include): include is string => typeof include === "string",
      )
    : [];
  return { aliases, includes };
};

const edgeKey = (edge: AppBoundaryEdge) =>
  `${edge.kind}\u0000${edge.source}\u0000${edge.specifier}\u0000${edge.target}`;

export const collectAppBoundaryEdges = (rootDir: string): AppBoundaryEdge[] => {
  const workspaces = readWorkspaces(rootDir);
  const apps = workspaces.filter(({ directory }) =>
    directory.startsWith("apps/"),
  );
  const repositoryFiles = listRepositoryFiles(rootDir);
  const edges: AppBoundaryEdge[] = [];

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
      aliases.push(...config.aliases);
      const source = toPosixPath(path.relative(rootDir, tsconfigPath));

      for (const { pattern, targets } of config.aliases) {
        for (const targetPath of targets) {
          const target = appForPath(targetPath.replace("*", ""), apps);
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

  return [
    ...new Map(edges.map((edge) => [edgeKey(edge), edge])).values(),
  ].toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
};

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

const readExceptions = (
  rootDir: string,
): { exceptions: AppBoundaryEdge[]; issues: AppBoundaryIssue[] } => {
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
  if (!Array.isArray(value)) {
    return {
      exceptions: [],
      issues: [
        {
          message: "app-boundary ledger must be a JSON array",
          path: APP_BOUNDARY_LEDGER_PATH,
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
        path: `${APP_BOUNDARY_LEDGER_PATH}:${index + 1}`,
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
        path: `${APP_BOUNDARY_LEDGER_PATH}:${index + 1}`,
      });
      continue;
    }
    seenKeys.add(key);
    exceptions.push(exception);
  }
  return { exceptions, issues };
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
      return edge.kind satisfies never;
  }
};

/**
 * This ledger may only shrink. The web/API Eden exceptions disappear when a
 * generated client contract replaces server-graph inference; the rich-chat
 * exception disappears when that contract has a true package owner. The legal
 * atlas/API exceptions disappear when ingestion owns a package-level data-access
 * boundary. The playground/web locale exception disappears when locale assets
 * have a shared package or generated owner.
 */
export const validateWorkspaceAppBoundaries = (
  rootDir: string,
): AppBoundaryIssue[] => {
  const observed = collectAppBoundaryEdges(rootDir);
  const { exceptions, issues } = readExceptions(rootDir);
  const observedKeys = new Set(observed.map(edgeKey));
  const exceptionKeys = new Set(exceptions.map(edgeKey));

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
