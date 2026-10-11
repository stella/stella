import { Result } from "better-result";
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

import { parseSource } from "./parse-memo";

const MAX_FILES = 2048;
const MAX_DEPTH = 64;
const MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_SOURCE = /\.[cm]?[jt]sx?$/u;
const DECLARATION_SOURCE = /\.d\.[cm]?ts$/u;

const packageIdentity = (specifier: string) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts.at(0);
};

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const repositorySource = (root: string, file: string) =>
  inside(root, file) &&
  !path.relative(root, file).split(path.sep).includes("node_modules");

const localSpecifier = (specifier: string) =>
  specifier.startsWith(".") ||
  path.isAbsolute(specifier) ||
  specifier.startsWith("@/") ||
  specifier.startsWith("@stll/");

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
    while (inside(repositoryRoot, current)) {
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
            const pathsBasePath = config.options.pathsBasePath;
            const base =
              config.options.baseUrl ??
              (typeof pathsBasePath === "string" ? pathsBasePath : current);
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
    if (resolved === undefined && inside(repositoryRoot, importer)) {
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
  return resolveImport;
};

const typeOnlyImport = (clause: ts.ImportClause | undefined) => {
  const bindings = clause?.namedBindings;
  return (
    clause?.isTypeOnly ||
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

const runtimeSpecifiers = (file: string, text: string) => {
  const specifiers: string[] = [];
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
        specifiers.push(node.moduleSpecifier.text);
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
        specifiers.push(node.moduleSpecifier.text);
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression !== undefined &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        specifiers.push(node.moduleReference.expression.text);
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments.at(0);
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  // parseSource selects JSX syntax from a .tsx suffix for both JS and TS sources.
  visit(parseSource({ fileName: file.replace(/\.jsx$/u, ".tsx"), text }));
  return specifiers;
};

type FixtureEvidenceOptions = {
  root: string;
  replayFiles: readonly string[];
  sdkNames: readonly string[];
};

/** Static runtime reachability; modules are resolved and parsed, never executed. */
export const readFixtureEvidence = ({
  root,
  replayFiles,
  sdkNames,
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
    inside(repositoryRoot, file) ? path.relative(repositoryRoot, file) : file;
  const resolveImport = createEvidenceResolver({
    repositoryRoot,
    read,
    label,
    problems,
  });
  const pending = replayFiles.map((file) => ({
    file: path.resolve(repositoryRoot, file),
    depth: 0,
  }));
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) {
      break;
    }
    const canonical = Result.try(() => realpathSync(entry.file));
    if (canonical.isErr()) {
      problems.push(`Cannot read replay/runtime source ${label(entry.file)}`);
      continue;
    }
    const file = canonical.value;
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
      owners.add(path.relative(repositoryRoot, file));
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
        if (localSpecifier(specifier) || target) {
          problems.push(
            `Cannot resolve runtime import ${JSON.stringify(specifier)} from ${label(file)}`,
          );
        }
        return;
      }
      if (target && identity !== undefined) {
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
      pending.push({ file: resolved, depth: entry.depth + 1 });
    };
    for (const specifier of runtimeSpecifiers(file, text)) {
      follow(specifier);
    }
  }
  return { owners, sdks, problems };
};
