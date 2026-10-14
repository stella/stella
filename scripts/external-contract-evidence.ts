import { panic, Result } from "better-result";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { parseSource } from "./parse-memo";

const MAX_FILES = 8192;
const MAX_DEPTH = 64;
const MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_SOURCE = /\.[cm]?[jt]sx?$/u;
const DECLARATION_SOURCE = /\.d\.[cm]?ts$/u;

const packageIdentity = (specifier: string) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts.at(0);
};

const repositorySource = (root: string, file: string) =>
  isPathInside(root, file) &&
  !repoRelativePath(root, file).split("/").includes("node_modules");

const localSpecifier = (specifier: string) =>
  specifier.startsWith(".") ||
  path.isAbsolute(specifier) ||
  specifier.startsWith("@/");

type EvidenceResolverOptions = {
  repositoryRoot: string;
  read: (file: string) => string | undefined;
  label: (file: string) => string;
  problems: string[];
};

const createEvidenceResolver = ({
  repositoryRoot,
  read,
  label,
  problems,
}: EvidenceResolverOptions) => {
  const configs = new Map<string, ts.ParsedCommandLine | undefined>();
  const resolutions = new Map<string, string | undefined>();
  const configAt = (directory: string) => {
    if (configs.has(directory)) {
      return configs.get(directory);
    }
    const configFile = path.join(directory, "tsconfig.json");
    const parsed = existsSync(configFile)
      ? ts.getParsedCommandLineOfConfigFile(
          configFile,
          {},
          {
            ...ts.sys,
            readFile: read,
            // Only resolution options are needed; do not enumerate project sources.
            readDirectory: () => [],
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              problems.push(
                `Cannot read ${label(configFile)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
              );
            },
          },
        )
      : undefined;
    configs.set(directory, parsed);
    return parsed;
  };
  const resolveCandidate = (candidate: string, directory: string) => {
    const result = Result.try(() =>
      realpathSync(Bun.resolveSync(candidate, directory)),
    );
    return result.isOk() && !DECLARATION_SOURCE.test(result.value)
      ? result.value
      : undefined;
  };
  const aliasResolution = (
    specifier: string,
    directory: string,
  ): string | undefined => {
    let current = directory;
    while (isPathInside(repositoryRoot, current)) {
      const config = configAt(current);
      if (config !== undefined) {
        for (const [pattern, replacements] of Object.entries(
          config.options.paths ?? {},
        )) {
          const star = pattern.indexOf("*");
          const prefix = star === -1 ? pattern : pattern.slice(0, star);
          const suffix = star === -1 ? "" : pattern.slice(star + 1);
          if (
            star === -1
              ? specifier !== pattern
              : !specifier.startsWith(prefix) || !specifier.endsWith(suffix)
          ) {
            continue;
          }
          const match =
            star === -1
              ? ""
              : specifier.slice(
                  prefix.length,
                  specifier.length - suffix.length,
                );
          for (const replacement of replacements) {
            const pathsBasePath = config.options["pathsBasePath"];
            const base =
              typeof pathsBasePath === "string" ? pathsBasePath : current;
            const candidate = path.resolve(
              base,
              replacement.replace("*", () => match),
            );
            const resolved = resolveCandidate(candidate, directory);
            if (resolved !== undefined) {
              return resolved;
            }
          }
        }
        // The nearest project owns its aliases; another project's config cannot repair it.
        return undefined;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return undefined;
  };
  const workspacePackages = new Map<string, string>();
  for (const container of ["apps", "packages"]) {
    const directory = path.join(repositoryRoot, container);
    const entries = Result.try(() =>
      readdirSync(directory, { withFileTypes: true }),
    );
    if (entries.isErr()) {
      continue;
    }
    for (const entry of entries.value) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDirectory = path.join(directory, entry.name);
      const manifest = read(path.join(packageDirectory, "package.json"));
      if (manifest === undefined) {
        continue;
      }
      const parsed = Result.try((): unknown => JSON.parse(manifest));
      if (
        parsed.isOk() &&
        typeof parsed.value === "object" &&
        parsed.value !== null &&
        "name" in parsed.value &&
        typeof parsed.value.name === "string"
      ) {
        workspacePackages.set(parsed.value.name, packageDirectory);
      }
    }
  }
  const resolveImport = (specifier: string, importer: string) => {
    const directory = path.dirname(importer);
    const key = `${directory}\0${specifier}`;
    if (resolutions.has(key)) {
      return resolutions.get(key);
    }
    let resolved = resolveCandidate(specifier, directory);
    if (resolved === undefined && isPathInside(repositoryRoot, importer)) {
      resolved = aliasResolution(specifier, directory);
    }
    const identity = packageIdentity(specifier);
    const workspace =
      identity === undefined ? undefined : workspacePackages.get(identity);
    if (resolved === undefined && workspace !== undefined) {
      // Bun applies the workspace package's runtime exports from its own directory.
      resolved = resolveCandidate(specifier, workspace);
    }
    resolutions.set(key, resolved);
    return resolved;
  };
  const workspaceSpecifier = (specifier: string) => {
    const identity = packageIdentity(specifier);
    return identity !== undefined && workspacePackages.has(identity);
  };
  const packageRoots = new Map<string, string | undefined>();
  const installedPackageRoot = (directory: string, identity: string) => {
    const key = `${directory}\0${identity}`;
    if (packageRoots.has(key)) {
      return packageRoots.get(key);
    }
    let current = directory;
    while (true) {
      const packageDirectory = path.join(current, "node_modules", identity);
      const candidate = Result.try(() => realpathSync(packageDirectory));
      if (candidate.isOk()) {
        packageRoots.set(key, candidate.value);
        return candidate.value;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    // Bun's real store paths can sit outside the checkout's module ancestry.
    const candidate = Result.try(() =>
      realpathSync(path.join(repositoryRoot, "node_modules", identity)),
    );
    const root = candidate.isOk() ? candidate.value : undefined;
    packageRoots.set(key, root);
    return root;
  };
  type ResolvedPackageOptions = {
    identity: string;
    importer: string;
    resolved: string;
  };
  const resolvedPackage = ({
    identity,
    importer,
    resolved,
  }: ResolvedPackageOptions) => {
    const workspace = workspacePackages.get(identity);
    const packageRoot =
      workspace === undefined
        ? installedPackageRoot(path.dirname(importer), identity)
        : Result.try(() => realpathSync(workspace)).unwrapOr(undefined);
    return packageRoot !== undefined && isPathInside(packageRoot, resolved);
  };
  return { resolveImport, workspaceSpecifier, resolvedPackage };
};

const typeOnlyImport = (clause: ts.ImportClause | undefined) => {
  const bindings = clause?.namedBindings;
  return (
    clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    (clause?.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly))
  );
};

const typeOnlyExport = (node: ts.ExportDeclaration) => {
  const clause = node.exportClause;
  return (
    node.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
};

type RuntimeModuleReference =
  | { readonly type: "literal"; readonly specifier: string }
  | { readonly type: "dynamic" };

type RuntimeModuleReferencesOptions = { file: string; text: string };

const referenceCache = new Map<
  string,
  { text: string; references: readonly RuntimeModuleReference[] }[]
>();

export const runtimeModuleReferences = ({
  file,
  text,
}: RuntimeModuleReferencesOptions): readonly RuntimeModuleReference[] => {
  const cached = referenceCache.get(file)?.find((entry) => entry.text === text);
  if (cached) {
    return cached.references;
  }
  const references: RuntimeModuleReference[] = [];
  const record = (expression: ts.Expression | undefined) => {
    if (expression !== undefined && ts.isStringLiteralLike(expression)) {
      references.push({ type: "literal", specifier: expression.text });
      return;
    }
    references.push({ type: "dynamic" });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) {
      return;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const onlyTypes = typeOnlyImport(node.importClause);
      if (!onlyTypes) {
        record(node.moduleSpecifier);
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const onlyTypes = typeOnlyExport(node);
      if (
        !onlyTypes &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        record(node.moduleSpecifier);
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression);
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      record(node.arguments.at(0));
    }
    ts.forEachChild(node, visit);
  };
  // parseSource selects JSX syntax from a .tsx suffix for both JS and TS sources.
  visit(parseSource({ fileName: file.replace(/\.jsx$/u, ".tsx"), text }));
  const recent = referenceCache.get(file) ?? [];
  recent.push({ text, references });
  if (recent.length > 2) {
    recent.shift();
  }
  referenceCache.set(file, recent);
  if (referenceCache.size > MAX_FILES) {
    const first = referenceCache.keys().next();
    if (!first.done) {
      referenceCache.delete(first.value);
    }
  }
  return references;
};

type LocalRuntimeSnapshotOptions = {
  root: string;
  read: (file: string) => string | undefined;
};

const matchesSnapshotAlias = (specifier: string, options: ts.CompilerOptions) =>
  Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return star === -1
      ? pattern === specifier
      : specifier.startsWith(pattern.slice(0, star)) &&
          specifier.endsWith(pattern.slice(star + 1));
  });

const SNAPSHOT_COMPILER_OPTIONS = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.Preserve,
  resolveJsonModule: true,
  customConditions: ["bun"],
} satisfies ts.CompilerOptions;

/** Resolve only repository runtime sources against one immutable snapshot. */
const createLocalSnapshotResolver = ({
  root,
  read,
}: LocalRuntimeSnapshotOptions) => {
  const repositoryRoot = path.resolve(root);
  const metadataProblems: string[] = [];
  const reads = new Map<string, string | undefined>();
  const workspaces = new Map<string, string | undefined>();
  const configs = new Map<string, ts.CompilerOptions>();
  const resolutions = new Map<string, LocalImportResolution>();
  const readRelative = (file: string) => {
    if (!reads.has(file)) {
      reads.set(file, read(file));
    }
    return reads.get(file);
  };
  const workspaceRoot = (identity: string) => {
    if (workspaces.has(identity)) {
      return workspaces.get(identity);
    }
    if (!identity.startsWith("@stll/")) {
      return undefined;
    }
    const name = identity.slice("@stll/".length);
    for (const container of ["packages", "apps"]) {
      const directory = `${container}/${name}`;
      const content = readRelative(`${directory}/package.json`);
      if (content === undefined) {
        continue;
      }
      const parsed = Result.try((): unknown => JSON.parse(content));
      if (
        parsed.isOk() &&
        typeof parsed.value === "object" &&
        parsed.value !== null &&
        "name" in parsed.value &&
        parsed.value.name === identity
      ) {
        const absolute = path.join(repositoryRoot, directory);
        workspaces.set(identity, absolute);
        return absolute;
      }
      metadataProblems.push(
        `Cannot read workspace manifest ${directory}/package.json`,
      );
    }
    workspaces.set(identity, undefined);
    return undefined;
  };
  const canonical = (file: string) => {
    const absolute = path.resolve(file);
    if (!isPathInside(repositoryRoot, absolute)) {
      return absolute;
    }
    const parts = repoRelativePath(repositoryRoot, absolute).split("/");
    const modules = parts.lastIndexOf("node_modules");
    if (modules === -1 || parts.at(modules + 1) !== "@stll") {
      return absolute;
    }
    const name = parts.at(modules + 2);
    const workspace =
      name === undefined ? undefined : workspaceRoot(`@stll/${name}`);
    return workspace === undefined
      ? absolute
      : path.join(workspace, ...parts.slice(modules + 3));
  };
  const readAbsolute = (file: string) => {
    const absolute = canonical(file);
    if (
      !isPathInside(repositoryRoot, absolute) ||
      repoRelativePath(repositoryRoot, absolute)
        .split("/")
        .includes("node_modules")
    ) {
      return undefined;
    }
    return readRelative(repoRelativePath(repositoryRoot, absolute));
  };
  const host = {
    fileExists: (file: string) =>
      !DECLARATION_SOURCE.test(file) && readAbsolute(file) !== undefined,
    readFile: readAbsolute,
    directoryExists: (directory: string) =>
      isPathInside(repositoryRoot, canonical(directory)),
    realpath: canonical,
    getCurrentDirectory: () => repositoryRoot,
    useCaseSensitiveFileNames: true,
  };
  const optionsAt = (file: string): ts.CompilerOptions => {
    let directory = path.dirname(file);
    const start = directory;
    while (isPathInside(repositoryRoot, directory)) {
      const cached = configs.get(directory);
      if (cached) {
        configs.set(start, cached);
        return cached;
      }
      const configFile = path.join(directory, "tsconfig.json");
      if (readAbsolute(configFile) !== undefined) {
        const config = ts.getParsedCommandLineOfConfigFile(
          configFile,
          {},
          {
            ...ts.sys,
            ...host,
            readDirectory: () => [],
            onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
              metadataProblems.push(
                `Cannot read ${repoRelativePath(repositoryRoot, configFile)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
              ),
          },
        );
        if (
          config?.errors.some(({ code }) => code !== 18_002 && code !== 18_003)
        ) {
          metadataProblems.push(
            `Invalid local runtime configuration ${repoRelativePath(repositoryRoot, configFile)}`,
          );
        }
        const options = {
          ...config?.options,
          ...SNAPSHOT_COMPILER_OPTIONS,
        };
        configs.set(start, options);
        configs.set(directory, options);
        return options;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    const options = SNAPSHOT_COMPILER_OPTIONS;
    configs.set(start, options);
    return options;
  };
  type LocalImportResolution =
    | { type: "external" }
    | { type: "resolved"; file: string }
    | { type: "unresolved" };
  type LocalImportOptions = { specifier: string; importer: string };
  const resolveImport = ({
    specifier,
    importer,
  }: LocalImportOptions): LocalImportResolution => {
    if (
      isBuiltin(specifier) ||
      specifier === "bun" ||
      specifier.startsWith("bun:")
    ) {
      return { type: "external" };
    }
    const options = optionsAt(importer);
    const identity = packageIdentity(specifier);
    const local =
      localSpecifier(specifier) ||
      specifier.startsWith("#") ||
      matchesSnapshotAlias(specifier, options) ||
      (identity !== undefined && identity.startsWith("@stll/"));
    if (!local) {
      return { type: "external" };
    }
    const key = `${importer}\0${specifier}`;
    const cached = resolutions.get(key);
    if (cached) {
      return cached;
    }
    const resolved = ts.resolveModuleName(
      specifier,
      importer,
      options,
      host,
    ).resolvedModule;
    const file =
      resolved === undefined ? undefined : canonical(resolved.resolvedFileName);
    const result =
      file !== undefined &&
      isPathInside(repositoryRoot, file) &&
      !repoRelativePath(repositoryRoot, file)
        .split("/")
        .includes("node_modules")
        ? ({ type: "resolved", file } as const)
        : ({ type: "unresolved" } as const);
    resolutions.set(key, result);
    return result;
  };
  return {
    repositoryRoot,
    canonical,
    readAbsolute,
    resolveImport,
    metadataProblems,
  };
};

export const createLocalRuntimeClosureReader = (
  options: LocalRuntimeSnapshotOptions,
) => {
  const {
    repositoryRoot,
    canonical,
    readAbsolute,
    resolveImport,
    metadataProblems,
  } = createLocalSnapshotResolver(options);
  return (roots: readonly string[]) => {
    const files = new Map<string, string>();
    const references: RuntimeModuleReference[] = [];
    const problems: string[] = [];
    const pending = roots.map((file) => ({
      file: path.resolve(repositoryRoot, file),
      depth: 0,
    }));
    let bytes = 0;
    for (const entry of pending) {
      const file = canonical(entry.file);
      if (
        !isPathInside(repositoryRoot, file) ||
        repoRelativePath(repositoryRoot, file)
          .split("/")
          .includes("node_modules")
      ) {
        problems.push(
          `Local runtime closure escaped the repository: ${entry.file}`,
        );
        continue;
      }
      const relative = repoRelativePath(repositoryRoot, file);
      if (files.has(relative)) {
        continue;
      }
      const text = readAbsolute(file);
      if (text === undefined) {
        problems.push(`Cannot read local runtime source ${relative}`);
        continue;
      }
      bytes += new TextEncoder().encode(text).byteLength;
      if (
        files.size >= MAX_FILES ||
        bytes > MAX_BYTES ||
        entry.depth > MAX_DEPTH
      ) {
        problems.push(
          `Local runtime closure exceeds its traversal bound at ${relative}`,
        );
        break;
      }
      files.set(relative, text);
      if (!RUNTIME_SOURCE.test(file)) {
        continue;
      }
      for (const reference of runtimeModuleReferences({
        file: relative,
        text,
      })) {
        references.push(reference);
        switch (reference.type) {
          case "dynamic":
            problems.push(
              `Cannot resolve non-literal local runtime reference from ${relative}`,
            );
            break;
          case "literal": {
            const specifier = reference.specifier;
            const resolution = resolveImport({ specifier, importer: file });
            switch (resolution.type) {
              case "external":
                break;
              case "unresolved":
                problems.push(
                  `Cannot resolve local runtime import ${JSON.stringify(specifier)} from ${relative}`,
                );
                break;
              case "resolved":
                pending.push({ file: resolution.file, depth: entry.depth + 1 });
                break;
              default:
                resolution satisfies never;
                panic("Unhandled local import resolution");
            }
            break;
          }
          default:
            reference satisfies never;
            panic("Unhandled runtime module reference");
        }
      }
    }
    return { files, references, problems: [...problems, ...metadataProblems] };
  };
};

type FixtureEvidenceOptions = {
  root: string;
  replayFiles: readonly string[];
  sdkNames: readonly string[];
  claims?: { owners: readonly string[]; sdks: readonly string[] };
};

type ReplayRootOptions = {
  repositoryRoot: string;
  replayFiles: readonly string[];
  label: (file: string) => string;
};

const readReplayRoots = ({
  repositoryRoot,
  replayFiles,
  label,
}: ReplayRootOptions) => {
  const problems: string[] = [];
  const pending: { file: string; depth: number }[] = [];
  for (const replayFile of replayFiles) {
    const source = path.resolve(repositoryRoot, replayFile);
    const canonical = Result.try(() => {
      const file = realpathSync(source);
      return statSync(file).isFile() ? file : undefined;
    });
    if (canonical.isErr() || canonical.value === undefined) {
      problems.push(`Cannot read replay/runtime source ${label(source)}`);
      continue;
    }
    pending.push({ file: canonical.value, depth: 0 });
  }
  return { pending, problems };
};

type ClaimedReachabilityOptions = {
  claims: NonNullable<FixtureEvidenceOptions["claims"]>;
  owners: ReadonlySet<string>;
  sdks: ReadonlySet<string>;
};

const missingClaims = ({
  claims,
  owners,
  sdks,
}: ClaimedReachabilityOptions) => {
  const problems: string[] = [];
  for (const [kind, requested, reached] of [
    ["owner", claims.owners, owners],
    ["SDK", claims.sdks, sdks],
  ] as const) {
    for (const target of requested) {
      if (!reached.has(target)) {
        problems.push(
          `Cannot prove runtime reachability for claimed ${kind} ${target}`,
        );
      }
    }
  }
  return problems;
};

/**
 * Static runtime reachability; modules are resolved and parsed, never executed.
 * Claims request positive paths only: unrelated graph diagnostics cannot refute a completed proof.
 * Every replay root is still checked, including roots unused by the successful paths.
 */
export const readFixtureEvidence = ({
  root,
  replayFiles,
  sdkNames,
  claims,
}: FixtureEvidenceOptions) => {
  const owners = new Set<string>();
  const sdks = new Set<string>();
  const problems: string[] = [];
  const resolvedRoot = Result.try(() => realpathSync(root));
  if (resolvedRoot.isErr()) {
    problems.push(`Cannot read fixture repository root ${root}`);
    return { owners, sdks, problems };
  }
  const repositoryRoot = resolvedRoot.value;
  const targets = new Set(sdkNames);
  const visited = new Set<string>();
  const reads = new Map<string, string | undefined>();
  let bytes = 0;
  let files = 0;
  const read = (file: string) => {
    if (reads.has(file)) {
      return reads.get(file);
    }
    const result = Result.try(() => readFileSync(file, "utf-8"));
    const text = result.isOk() ? result.value : undefined;
    reads.set(file, text);
    return text;
  };
  const label = (file: string) =>
    isPathInside(repositoryRoot, file)
      ? repoRelativePath(repositoryRoot, file)
      : file;
  const { pending, problems: rootProblems } = readReplayRoots({
    repositoryRoot,
    replayFiles,
    label,
  });
  problems.push(...rootProblems);
  const proved = () =>
    claims !== undefined &&
    claims.owners.every((owner) => owners.has(owner)) &&
    claims.sdks.every((sdk) => sdks.has(sdk));
  if (proved()) {
    return { owners, sdks, problems: rootProblems };
  }
  const { resolveImport, workspaceSpecifier, resolvedPackage } =
    createEvidenceResolver({
      repositoryRoot,
      read,
      label,
      problems,
    });
  let cursor = 0;
  // Breadth-first search finds short proof paths before unrelated application branches.
  while (cursor < pending.length) {
    const entry = pending.at(cursor);
    cursor += 1;
    if (entry === undefined) {
      break;
    }
    const file = entry.file;
    if (visited.has(file) || DECLARATION_SOURCE.test(file)) {
      continue;
    }
    visited.add(file);
    if (entry.depth > MAX_DEPTH) {
      problems.push(
        `Runtime import graph exceeds depth bound ${MAX_DEPTH} at ${label(file)}`,
      );
      break;
    }
    if (repositorySource(repositoryRoot, file)) {
      owners.add(repoRelativePath(repositoryRoot, file));
    }
    if (proved()) {
      return { owners, sdks, problems: rootProblems };
    }
    if (!RUNTIME_SOURCE.test(file)) {
      continue;
    }
    const size = Result.try(() => statSync(file).size);
    if (size.isErr()) {
      problems.push(`Cannot inspect runtime source ${label(file)}`);
      continue;
    }
    files += 1;
    bytes += size.value;
    if (files > MAX_FILES || bytes > MAX_BYTES) {
      problems.push(
        `Runtime import graph exceeds bound (${MAX_FILES} files, ${MAX_BYTES} bytes) at ${label(file)}`,
      );
      break;
    }
    const text = read(file);
    if (text === undefined) {
      problems.push(`Cannot read runtime source ${label(file)}`);
      continue;
    }
    const follow = (specifier: string) => {
      if (
        isBuiltin(specifier) ||
        specifier === "bun" ||
        specifier.startsWith("bun:")
      ) {
        return;
      }
      const identity = packageIdentity(specifier);
      const target = identity !== undefined && targets.has(identity);
      const resolved = resolveImport(specifier, file);
      if (resolved === undefined) {
        if (
          localSpecifier(specifier) ||
          workspaceSpecifier(specifier) ||
          target
        ) {
          problems.push(
            `Cannot resolve runtime import ${JSON.stringify(specifier)} from ${label(file)}`,
          );
        }
        return;
      }
      if (target && resolvedPackage({ identity, importer: file, resolved })) {
        sdks.add(identity);
      }
      // Non-target third-party libraries are terminal: missing indirect evidence stays uncharacterised.
      if (
        !target &&
        !localSpecifier(specifier) &&
        !repositorySource(repositoryRoot, resolved)
      ) {
        return;
      }
      if (
        entry.depth < MAX_DEPTH &&
        repositorySource(repositoryRoot, resolved)
      ) {
        owners.add(repoRelativePath(repositoryRoot, resolved));
      }
      pending.push({ file: resolved, depth: entry.depth + 1 });
    };
    for (const reference of runtimeModuleReferences({ file, text })) {
      switch (reference.type) {
        case "literal":
          follow(reference.specifier);
          break;
        case "dynamic":
          problems.push(
            `Cannot resolve non-literal runtime module reference from ${label(file)}`,
          );
          break;
        default:
          reference satisfies never;
          panic("Unhandled runtime module reference");
      }
    }
    if (proved()) {
      return { owners, sdks, problems: rootProblems };
    }
  }
  if (claims !== undefined) {
    problems.push(...missingClaims({ claims, owners, sdks }));
  }
  return { owners, sdks, problems };
};
