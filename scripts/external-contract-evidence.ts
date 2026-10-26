import { panic, Result } from "better-result";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { withoutTsgoOnlyOptionDiagnostics } from "../packages/scripts/src/tsgo-compiler-options";
import {
  type Generator,
  GENERATORS,
  matchesGeneratedGlob,
} from "./generated-files";
import { isGeneratedCandidate } from "./generated-source-identification";
import { parseSource } from "./parse-memo";

// Runtime assets and registered generator inputs can include Markdown anywhere in the tracked tree.
export const CI_MARKDOWN_READER_INPUTS = ["**/*.md"];
export const CI_MARKDOWN_READER_COMMAND =
  "bun scripts/external-contract-evidence.ts --check";

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

type RuntimeModuleSyntax =
  "esm-import" | "dynamic-import" | "require" | "import-equals-require";

const resolutionModeFor = (
  syntax: RuntimeModuleSyntax,
): Exclude<ts.ResolutionMode, undefined> => {
  switch (syntax) {
    case "require":
    case "import-equals-require":
      return ts.ModuleKind.CommonJS;
    case "esm-import":
    case "dynamic-import":
      return ts.ModuleKind.ESNext;
    default:
      syntax satisfies never;
      return panic("Unhandled runtime module syntax");
  }
};

type ResolveRuntimeReferenceOptions = {
  fromDir: string;
  specifier: string;
  syntax: RuntimeModuleSyntax;
  importer: string;
  compilerOptions: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  cache: Map<string, string | undefined>;
};

/** The sole owner of runtime module resolution and its syntax-sensitive cache. */
export const resolveRuntimeReference = ({
  fromDir,
  specifier,
  syntax,
  importer,
  compilerOptions,
  host,
  cache,
}: ResolveRuntimeReferenceOptions): string | undefined => {
  const key = `${fromDir}\0${specifier}\0${syntax}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const resolved = ts.resolveModuleName(
    specifier,
    importer,
    compilerOptions,
    host,
    undefined,
    undefined,
    resolutionModeFor(syntax),
  ).resolvedModule?.resolvedFileName;
  cache.set(key, resolved);
  return resolved;
};

type EvidenceResolverOptions = {
  repositoryRoot: string;
  read: (file: string) => string | undefined;
  label: (file: string) => string;
  problems: string[];
};

const readWorkspacePackageRoots = (
  repositoryRoot: string,
  read: (file: string) => string | undefined,
) => {
  const packages = new Map<string, string>();
  for (const container of ["apps", "packages"]) {
    const directory = path.join(repositoryRoot, container);
    const entries = Result.try(() =>
      readdirSync(directory, { withFileTypes: true }),
    );
    if (entries.isErr()) {
      continue;
    }
    for (const entry of entries.value) {
      const packageDirectory = path.join(directory, entry.name);
      const manifest = entry.isDirectory()
        ? read(path.join(packageDirectory, "package.json"))
        : undefined;
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
        packages.set(parsed.value.name, packageDirectory);
      }
    }
  }
  return packages;
};

const createEvidenceResolver = ({
  repositoryRoot,
  read,
  label,
  problems,
}: EvidenceResolverOptions) => {
  const configs = new Map<string, ts.ParsedCommandLine | undefined>();
  const resolutions = new Map<string, string | undefined>();
  const runtimeHost = {
    ...ts.sys,
    fileExists: (file: string) =>
      !DECLARATION_SOURCE.test(file) && ts.sys.fileExists(file),
  };
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
  const resolveCandidate = (
    candidate: string,
    directory: string,
    syntax: RuntimeModuleSyntax,
  ) => {
    const resolved = resolveRuntimeReference({
      fromDir: directory,
      specifier: candidate,
      syntax,
      importer: path.join(directory, "__runtime_reference__.ts"),
      compilerOptions: {
        ...configAt(directory)?.options,
        ...SNAPSHOT_COMPILER_OPTIONS,
      },
      host: runtimeHost,
      cache: resolutions,
    });
    if (resolved === undefined || DECLARATION_SOURCE.test(resolved)) {
      return undefined;
    }
    return Result.try(() => realpathSync(resolved)).unwrapOr(undefined);
  };
  const aliasResolution = (
    specifier: string,
    directory: string,
    syntax: RuntimeModuleSyntax,
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
            const resolved = resolveCandidate(candidate, directory, syntax);
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
  const workspacePackages = readWorkspacePackageRoots(repositoryRoot, read);
  const resolveImport = (
    specifier: string,
    importer: string,
    syntax: RuntimeModuleSyntax,
  ) => {
    const directory = path.dirname(importer);
    let resolved = resolveCandidate(specifier, directory, syntax);
    if (resolved === undefined && isPathInside(repositoryRoot, importer)) {
      resolved = aliasResolution(specifier, directory, syntax);
    }
    const identity = packageIdentity(specifier);
    const workspace =
      identity === undefined ? undefined : workspacePackages.get(identity);
    if (resolved === undefined && workspace !== undefined) {
      // Bun applies the workspace package's runtime exports from its own directory.
      resolved = resolveCandidate(specifier, workspace, syntax);
    }
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
  | {
      readonly type: "literal";
      readonly specifier: string;
      readonly syntax: RuntimeModuleSyntax;
    }
  | {
      readonly type: "dynamic";
      readonly syntax: RuntimeModuleSyntax;
      readonly reason?: string;
    };

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
  const source = parseSource({
    fileName: file.replace(/\.jsx$/u, ".tsx"),
    text,
  });
  const factories = new Set(["createRequire"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      typeOnlyImport(statement.importClause)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          (binding.propertyName ?? binding.name).text === "createRequire"
        ) {
          factories.add(binding.name.text);
        }
      }
    }
  }
  const isLoader = (node: ts.Node) =>
    (ts.isIdentifier(node) && node.text === "require") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "require") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "require");
  const isFactory = (node: ts.Node) =>
    (ts.isIdentifier(node) && factories.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "createRequire") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "createRequire");
  const record = (
    expression: ts.Expression | undefined,
    syntax: RuntimeModuleSyntax,
  ) => {
    if (expression !== undefined && ts.isStringLiteralLike(expression)) {
      references.push({ type: "literal", specifier: expression.text, syntax });
      return;
    }
    references.push({ type: "dynamic", syntax });
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
        record(node.moduleSpecifier, "esm-import");
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (typeOnlyExport(node)) {
        return;
      }
      if (
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        record(node.moduleSpecifier, "esm-import");
        return;
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression, "import-equals-require");
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const directFactory =
        ts.isCallExpression(node.expression) &&
        isFactory(node.expression.expression);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isLoader(node.expression) ||
        directFactory
      ) {
        record(
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            node.arguments.length === 1
            ? node.arguments.at(0)
            : undefined,
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? "dynamic-import"
            : "require",
        );
        for (const argument of node.arguments) {
          visit(argument);
        }
        if (directFactory && ts.isCallExpression(node.expression)) {
          for (const argument of node.expression.arguments) {
            visit(argument);
          }
        }
        return;
      }
    }
    if (isLoader(node) || isFactory(node)) {
      references.push({
        type: "dynamic",
        syntax: "require",
        reason: "Indirect CommonJS loader use",
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  // parseSource selects JSX syntax from a .tsx suffix for both JS and TS sources.
  visit(source);
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

export type RuntimeSnapshotReader = ((file: string) => string | undefined) & {
  files?: readonly string[] | undefined;
  blobId?: ((file: string) => string | undefined) | undefined;
  byteLength?: ((file: string) => number | undefined) | undefined;
};
type GeneratedClosureDefinition = Pick<
  Generator,
  "id" | "outputs" | "inputs" | "write" | "outputKind"
>;
type LocalRuntimeSnapshotOptions = {
  root: string;
  read: RuntimeSnapshotReader;
  generators?: readonly GeneratedClosureDefinition[] | undefined;
  registryFiles?: readonly string[] | undefined;
};

const createGeneratedClosureReader = ({
  read,
  generators = GENERATORS,
  registryFiles = [
    "scripts/generated-files.ts",
    "packages/scripts/src/generated-files.ts",
  ],
}: LocalRuntimeSnapshotOptions) => {
  const registrationCache = new Map<string, GeneratedClosureDefinition[]>();
  const registered = (file: string) => {
    const cached = registrationCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const matches = generators.filter((generator) =>
      generator.outputs.some((glob) => matchesGeneratedGlob(glob, file)),
    );
    registrationCache.set(file, matches);
    return matches;
  };
  const derivedOutputs = generators
    .filter(({ outputKind }) => outputKind === "derived")
    .flatMap(({ outputs }) => outputs);
  const derived = (file: string) =>
    derivedOutputs.some((output) =>
      /[*?[\]{}]/u.test(output)
        ? matchesGeneratedGlob(output, file)
        : output === file,
    );
  const collectInputs = (file: string) => {
    const matches = registered(file).filter(
      ({ outputKind }) => outputKind === "derived",
    );
    const generator = matches.at(0);
    if (
      matches.length !== 1 ||
      generator === undefined ||
      generator.inputs.length === 0
    ) {
      return {
        type: "invalid",
        reason: `Generated module ${file} has no unique generator with declared inputs`,
      } as const;
    }
    const selected = new Set(registryFiles);
    for (const input of generator.inputs) {
      if (/[*?[\]{}]/u.test(input)) {
        if (read.files === undefined) {
          return {
            type: "invalid",
            reason: `Generated module ${file} lacks a tracked input inventory for ${generator.id}`,
          } as const;
        }
        const files = read.files.filter(
          (candidate) =>
            matchesGeneratedGlob(input, candidate) &&
            !generator.outputs.some((output) =>
              matchesGeneratedGlob(output, candidate),
            ),
        );
        if (files.length === 0) {
          return {
            type: "invalid",
            reason: `Generated module ${file} has no tracked matches for ${input}`,
          } as const;
        }
        for (const candidate of files) {
          selected.add(candidate);
        }
      } else {
        selected.add(input);
      }
    }
    for (const argument of generator.write) {
      if (/\.[cm]?[jt]s$/u.test(argument)) {
        selected.add(argument);
      }
    }
    return {
      type: "inputs",
      files: [...selected].toSorted(),
      identity: JSON.stringify({
        id: generator.id,
        inputs: generator.inputs,
        write: generator.write,
      }),
    } as const;
  };
  const inputCache = new Map<string, ReturnType<typeof collectInputs>>();
  const inputs = (file: string) => {
    const cached = inputCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = collectInputs(file);
    inputCache.set(file, source);
    return source;
  };
  return { registered, derived, inputs };
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

const createSnapshotFileReader = ({
  root,
  read,
}: LocalRuntimeSnapshotOptions) => {
  const repositoryRoot = path.resolve(root);
  const metadataProblems: string[] = [];
  const reads = new Map<string, string | undefined>();
  const workspaces = new Map<string, string | undefined>();
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
  const localReferences = new Map<string, boolean>();
  const declaresLocalPackage = ({
    identity,
    importer,
  }: {
    identity: string;
    importer: string;
  }) => {
    const key = `${importer}\0${identity}`;
    const cached = localReferences.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let directory = path.dirname(importer);
    while (isPathInside(repositoryRoot, directory)) {
      const file = path.join(directory, "package.json");
      const text = readAbsolute(file);
      if (text !== undefined) {
        const parsed = Result.try((): unknown => JSON.parse(text));
        if (
          parsed.isErr() ||
          typeof parsed.value !== "object" ||
          parsed.value === null
        ) {
          metadataProblems.push(
            `Cannot read package manifest ${repoRelativePath(repositoryRoot, file)}`,
          );
          return false;
        }
        for (const [section, dependencies] of Object.entries(parsed.value)) {
          if (
            ![
              "dependencies",
              "devDependencies",
              "optionalDependencies",
              "peerDependencies",
            ].includes(section) ||
            typeof dependencies !== "object" ||
            dependencies === null
          ) {
            continue;
          }
          const value: unknown = Object.entries(dependencies)
            .find(([name]) => name === identity)
            ?.at(1);
          if (typeof value === "string") {
            const local = /^(?:workspace|file|link):/u.test(value);
            localReferences.set(key, local);
            return local;
          }
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    localReferences.set(key, false);
    return false;
  };
  const privateImport = ({
    specifier,
    importer,
  }: {
    specifier: string;
    importer: string;
  }) => {
    let directory = path.dirname(importer);
    while (isPathInside(repositoryRoot, directory)) {
      const file = path.join(directory, "package.json");
      const text = readAbsolute(file);
      if (text !== undefined) {
        const parsed = Result.try((): unknown => JSON.parse(text));
        if (
          parsed.isErr() ||
          typeof parsed.value !== "object" ||
          parsed.value === null
        ) {
          metadataProblems.push(
            `Cannot read package manifest ${repoRelativePath(repositoryRoot, file)}`,
          );
          return undefined;
        }
        const imports: unknown = Object.entries(parsed.value)
          .find(([name]) => name === "imports")
          ?.at(1);
        if (typeof imports !== "object" || imports === null) {
          return undefined;
        }
        const target: unknown = Object.entries(imports)
          .find(([name]) => name === specifier)
          ?.at(1);
        if (typeof target !== "string") {
          metadataProblems.push(
            `Cannot prove literal private import ${specifier} from ${repoRelativePath(repositoryRoot, file)}`,
          );
          return undefined;
        }
        return {
          specifier: target,
          manifest: repoRelativePath(repositoryRoot, file),
        };
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    return undefined;
  };
  return {
    repositoryRoot,
    metadataProblems,
    canonical,
    readAbsolute,
    workspaceRoot,
    declaresLocalPackage,
    privateImport,
  };
};

type LiteralAssetOptions = {
  specifier: string;
  importer: string;
  options: ts.CompilerOptions;
  repositoryRoot: string;
  hasBlob: (file: string) => boolean;
};
const resolveLiteralAsset = ({
  specifier,
  importer,
  options,
  repositoryRoot,
  hasBlob,
}: LiteralAssetOptions) => {
  const assets = specifier.startsWith(".")
    ? [path.resolve(path.dirname(importer), specifier)]
    : [];
  const pathsBase =
    typeof options["pathsBasePath"] === "string"
      ? options["pathsBasePath"]
      : repositoryRoot;
  for (const [pattern, replacements] of Object.entries(options.paths ?? {})) {
    const star = pattern.indexOf("*");
    const matches =
      star === -1
        ? pattern === specifier
        : specifier.startsWith(pattern.slice(0, star)) &&
          specifier.endsWith(pattern.slice(star + 1));
    if (!matches) {
      continue;
    }
    const segment =
      star === -1
        ? ""
        : specifier.slice(star, specifier.length - (pattern.length - star - 1));
    for (const replacement of replacements) {
      assets.push(
        path.resolve(
          pathsBase,
          replacement.replace("*", () => segment),
        ),
      );
    }
  }
  return assets.find(
    (candidate) =>
      !RUNTIME_SOURCE.test(candidate) &&
      !DECLARATION_SOURCE.test(candidate) &&
      hasBlob(candidate),
  );
};

/** Resolve only repository runtime sources against one immutable snapshot. */
const createLocalSnapshotResolver = (snapshot: LocalRuntimeSnapshotOptions) => {
  const {
    repositoryRoot,
    metadataProblems,
    canonical,
    readAbsolute,
    workspaceRoot,
    declaresLocalPackage,
    privateImport,
  } = createSnapshotFileReader(snapshot);
  const configs = new Map<string, ts.CompilerOptions>();
  const resolutions = new Map<string, LocalImportResolution>();
  const runtimeResolutions = new Map<string, string | undefined>();
  const generated = createGeneratedClosureReader(snapshot);
  const hasBlob = (file: string) => {
    const absolute = canonical(file);
    return (
      isPathInside(repositoryRoot, absolute) &&
      !repoRelativePath(repositoryRoot, absolute)
        .split("/")
        .includes("node_modules") &&
      snapshot.read.blobId?.(repoRelativePath(repositoryRoot, absolute)) !==
        undefined
    );
  };
  const host = {
    fileExists: (file: string) =>
      !DECLARATION_SOURCE.test(file) &&
      ((RUNTIME_SOURCE.test(file)
        ? readAbsolute(file) !== undefined
        : hasBlob(file)) ||
        generated.derived(repoRelativePath(repositoryRoot, canonical(file)))),
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
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              metadataProblems.push(
                `Cannot read ${repoRelativePath(repositoryRoot, configFile)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
              );
            },
          },
        );
        if (
          withoutTsgoOnlyOptionDiagnostics(config?.errors ?? []).some(
            ({ code }) => code !== 18_002 && code !== 18_003,
          )
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
  type LocalImportResolution = (
    | { type: "external"; specifier: string }
    | { type: "resolved"; file: string }
    | { type: "unresolved" }
  ) & { inputs?: readonly string[] };
  type LocalImportOptions = {
    specifier: string;
    importer: string;
    syntax: RuntimeModuleSyntax;
  };
  const resolveImport = ({
    specifier,
    importer,
    syntax,
  }: LocalImportOptions): LocalImportResolution => {
    if (
      isBuiltin(specifier) ||
      specifier === "bun" ||
      specifier.startsWith("bun:")
    ) {
      return { type: "external", specifier };
    }
    const options = optionsAt(importer);
    const alias = specifier.startsWith("#")
      ? privateImport({ specifier, importer })
      : undefined;
    const target = alias?.specifier ?? specifier;
    const support = alias === undefined ? {} : { inputs: [alias.manifest] };
    const identity = packageIdentity(target);
    if (
      alias !== undefined &&
      identity !== undefined &&
      !localSpecifier(target) &&
      !target.startsWith("#") &&
      workspaceRoot(identity) === undefined &&
      !declaresLocalPackage({ identity, importer })
    ) {
      return { type: "external", specifier: target, ...support };
    }
    const local =
      localSpecifier(specifier) ||
      specifier.startsWith("#") ||
      matchesSnapshotAlias(specifier, options) ||
      (identity !== undefined &&
        (workspaceRoot(identity) !== undefined ||
          declaresLocalPackage({ identity, importer })));
    if (!local) {
      return { type: "external", specifier };
    }
    const key = `${path.dirname(importer)}\0${specifier}\0${syntax}`;
    const cached = resolutions.get(key);
    if (cached) {
      return cached;
    }
    const asset = resolveLiteralAsset({
      specifier,
      importer,
      options,
      repositoryRoot,
      hasBlob,
    });
    if (asset !== undefined) {
      const result = {
        type: "resolved",
        file: canonical(asset),
        ...support,
      } as const;
      resolutions.set(key, result);
      return result;
    }
    const resolvedFileName = resolveRuntimeReference({
      fromDir: path.dirname(importer),
      specifier,
      syntax,
      importer,
      compilerOptions: options,
      host,
      cache: runtimeResolutions,
    });
    const file =
      resolvedFileName === undefined ? undefined : canonical(resolvedFileName);
    const result =
      file !== undefined &&
      isPathInside(repositoryRoot, file) &&
      !repoRelativePath(repositoryRoot, file)
        .split("/")
        .includes("node_modules")
        ? ({ type: "resolved", file, ...support } as const)
        : ({ type: "unresolved", ...support } as const);
    resolutions.set(key, result);
    return result;
  };
  return {
    repositoryRoot,
    canonical,
    readAbsolute,
    resolveImport,
    metadataProblems,
    generated,
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
    generated,
  } = createLocalSnapshotResolver(options);
  return (roots: readonly string[]) => {
    const files = new Map<string, string>();
    const generatedLeaves = new Map<string, string>();
    const dataBlobIds = new Map<string, string>();
    const visited = new Set<string>();
    const countedFiles = new Set<string>();
    const references: RuntimeModuleReference[] = [];
    const problems: string[] = [];
    const pending: {
      file: string;
      depth: number;
      mode: "runtime" | "input";
    }[] = roots.map((file) => ({
      file: path.resolve(repositoryRoot, file),
      depth: 0,
      mode: "runtime",
    }));
    let bytes = 0;
    type IncludeSourceOptions = { relative: string; text: string };
    const includeSource = ({ relative, text }: IncludeSourceOptions) => {
      if (files.has(relative)) {
        return undefined;
      }
      const size =
        options.read.byteLength === undefined
          ? new TextEncoder().encode(text).byteLength
          : options.read.byteLength(relative);
      if (size === undefined) {
        return `Cannot measure runtime source bytes ${relative}`;
      }
      bytes += size;
      if (files.size >= MAX_FILES || bytes > MAX_BYTES) {
        return `Local runtime closure exceeds its traversal bound at ${relative} (${files.size} files, ${bytes} bytes)`;
      }
      files.set(relative, text);
      return undefined;
    };
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
      const visitKey = `${entry.mode}\0${relative}`;
      if (visited.has(visitKey)) {
        continue;
      }
      if (
        (!countedFiles.has(relative) && countedFiles.size >= MAX_FILES) ||
        entry.depth > MAX_DEPTH
      ) {
        problems.push(
          `Local runtime closure exceeds its traversal bound at ${relative} (${countedFiles.size} unique files, depth ${entry.depth})`,
        );
        break;
      }
      visited.add(visitKey);
      countedFiles.add(relative);
      if (generated.derived(relative)) {
        const source = generated.inputs(relative);
        if (source.type === "invalid") {
          problems.push(source.reason);
          continue;
        }
        generatedLeaves.set(relative, source.identity);
        for (const input of source.files) {
          pending.push({
            file: path.resolve(repositoryRoot, input),
            depth: entry.depth + 1,
            mode: RUNTIME_SOURCE.test(input) ? "runtime" : "input",
          });
        }
        continue;
      }
      if (!RUNTIME_SOURCE.test(file)) {
        const id = options.read.blobId?.(relative);
        if (id === undefined) {
          problems.push(`Cannot resolve runtime data blob ${relative}`);
          continue;
        }
        dataBlobIds.set(relative, id);
        continue;
      }
      const text = readAbsolute(file);
      if (text === undefined) {
        problems.push(`Cannot read local runtime source ${relative}`);
        continue;
      }
      const accountingProblem = includeSource({ relative, text });
      if (accountingProblem !== undefined) {
        problems.push(accountingProblem);
        break;
      }
      if (entry.mode === "input") {
        continue;
      }
      if (
        isGeneratedCandidate(relative, text) &&
        generated.registered(relative).length === 0
      ) {
        problems.push(
          `Generated module ${relative} has no registered generator`,
        );
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
              `${reference.reason ?? "Cannot resolve non-literal local runtime reference"} from ${relative}`,
            );
            break;
          case "literal": {
            const specifier = reference.specifier;
            const resolution = resolveImport({
              specifier,
              importer: file,
              syntax: reference.syntax,
            });
            for (const input of resolution.inputs ?? []) {
              pending.push({
                file: path.resolve(repositoryRoot, input),
                depth: entry.depth + 1,
                mode: "input",
              });
            }
            switch (resolution.type) {
              case "external":
                if (resolution.specifier !== specifier) {
                  references.push({
                    type: "literal",
                    specifier: resolution.specifier,
                    syntax: reference.syntax,
                  });
                }
                break;
              case "unresolved":
                problems.push(
                  `Cannot resolve local runtime import ${JSON.stringify(specifier)} from ${relative}`,
                );
                break;
              case "resolved":
                pending.push({
                  file: resolution.file,
                  depth: entry.depth + 1,
                  mode: "runtime",
                });
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
    return {
      files,
      generated: generatedLeaves,
      dataBlobIds,
      references,
      problems: [...problems, ...metadataProblems],
    };
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
    const follow = (specifier: string, syntax: RuntimeModuleSyntax) => {
      if (
        isBuiltin(specifier) ||
        specifier === "bun" ||
        specifier.startsWith("bun:")
      ) {
        return;
      }
      const identity = packageIdentity(specifier);
      const target = identity !== undefined && targets.has(identity);
      const resolved = resolveImport(specifier, file, syntax);
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
          follow(reference.specifier, reference.syntax);
          break;
        case "dynamic":
          problems.push(
            `${reference.reason ?? "Cannot resolve non-literal runtime module reference"} from ${label(file)}`,
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

if (import.meta.main) {
  const { runExternalContractCheck } =
    await import("./check-external-contracts");
  runExternalContractCheck();
}
