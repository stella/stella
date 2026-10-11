#!/usr/bin/env bun
import { panic } from "better-result";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  apiResolvedTypecheckInputs,
  nativeTypecheckProgramFiles,
} from "./api-typecheck-inputs";
import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";
import { readTurboTypecheckInputs } from "./turbo-typecheck-inputs";

export const typescriptModuleReferences = (text: string, filename: string) => {
  const imports = new Set<string>();
  let dynamic = false;
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    false,
  );
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      imports.add(node.argument.literal.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.add(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        imports.add(argument.text);
      } else {
        dynamic = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, dynamic };
};

export const apiDeclarationCacheInputs = apiResolvedTypecheckInputs;

// Bun redirects explicit reference roots, so the roots must include every API
// module retained by declaration serialization, not just the entry modules.
const apiDeclarationSurfaceFiles = (
  project: string,
  files: readonly string[],
) => {
  const configPath = path.resolve(project);
  const directory = path.dirname(configPath);
  const api = ts.sys.realpath?.(directory) ?? directory;
  const source = `${path.join(api, "src")}${path.sep}`;
  const roots = [
    ...new Set(
      files
        .map((file) => ts.sys.realpath?.(file) ?? file)
        .filter((file) => file.startsWith(source) && /\.[cm]?tsx?$/u.test(file))
        .map((file) => path.relative(api, file)),
    ),
  ].toSorted();
  if (roots.length === 0) {
    panic("API declaration surface has no source modules");
  }
  return roots;
};

export const writeApiDeclarationSurface = (
  project: string,
  files: readonly string[],
) => {
  const configPath = path.resolve(project);
  const roots = apiDeclarationSurfaceFiles(project, files);
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (config.error) {
    panic(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config.config, files: roots }, null, 2)}\n`,
  );
  return roots;
};

export const missingDeclarationCacheInputs = (
  files: readonly string[],
  project: string,
) => {
  const directory = path.dirname(path.resolve(project));
  const api = ts.sys.realpath?.(directory) ?? directory;
  const root = path.resolve(api, "../..");
  const turbo = path.join(root, "turbo.json");
  if (!existsSync(turbo)) {
    return [];
  }
  const config = readTurboTypecheckInputs(turbo);
  const inputs = config.tasks["@stll/api#typecheck:declarations"]?.inputs ?? [];
  const exact = new Set(
    inputs
      .filter((input) => !/[!*?{]/u.test(input))
      .map((input) =>
        path.resolve(
          input.startsWith("$TURBO_ROOT$/") ? root : api,
          input.replace("$TURBO_ROOT$/", ""),
        ),
      ),
  );
  const patterns = inputs
    .filter((input) => /[!*?{]/u.test(input))
    .map((input) => {
      const pattern = input.startsWith("!") ? input.slice(1) : input;
      return {
        excluded: input.startsWith("!"),
        root: pattern.startsWith("$TURBO_ROOT$/") ? root : api,
        glob: new Bun.Glob(pattern.replace("$TURBO_ROOT$/", "")),
      };
    });
  return files.filter((filename) => {
    const source = ts.sys.realpath?.(filename) ?? filename;
    const matches = patterns.filter((pattern) =>
      pattern.glob.match(path.relative(pattern.root, source)),
    );
    return (
      matches.some((pattern) => pattern.excluded) ||
      (!exact.has(source) && !matches.some((pattern) => !pattern.excluded))
    );
  });
};

// Route and server contracts belong to the source checker, never to the
// declaration surface consumed by secondary compiler programs.
const isApiRuntimeBoundary = (source: ts.SourceFile) => {
  const relative = source.fileName
    .replaceAll(path.sep, "/")
    .split("/apps/api/src/")[1];
  if (!relative) {
    return false;
  }
  if (
    relative === "lib/auth.ts" ||
    /(?:^|[-/])routes(?:[-.]|$)/u.test(relative) ||
    /(?:^|[-/])(?:route|server)\.[cm]?tsx?$/u.test(relative)
  ) {
    return true;
  }
  const constructors = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !["elysia", "@modelcontextprotocol/server"].includes(
        statement.moduleSpecifier.text,
      )
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name && statement.moduleSpecifier.text === "elysia") {
      constructors.add(clause.name.text);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (imported === "Elysia" || imported === "Server") {
          constructors.add(binding.name.text);
        }
      }
    }
  }
  let route = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      constructors.has(node.expression.text)
    ) {
      route = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return route;
};

// Emit the explicit public roots and their declaration dependencies. Runtime
// imports erased from declarations do not require serializing their exports.
export const emitApiTypecheckDeclarations = (project: string) => {
  const configPath = path.resolve(project);
  const config = ts.readConfigFile(configPath, (filename) =>
    ts.sys.readFile(filename),
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const diagnostics = withoutTsgoOnlyOptionDiagnostics(
    config.error ? [config.error, ...parsed.errors] : parsed.errors,
  );
  if (diagnostics.length > 0) {
    return { diagnostics, files: [] };
  }
  const outDir = parsed.options.outDir;
  if (
    !outDir ||
    !parsed.options.noCheck ||
    !parsed.options.emitDeclarationOnly
  ) {
    panic(
      "API declaration project must use noCheck, emitDeclarationOnly and outDir",
    );
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, declarationMap: false },
  });
  const resolutionCache = ts.createModuleResolutionCache(
    path.dirname(configPath),
    (filename) => filename,
    parsed.options,
  );
  const queue = [...parsed.fileNames];
  const parents = new Map<string, string>();
  const emitted = new Set<string>();
  const outputs = new Map<string, string>();
  for (const filename of queue) {
    if (!filename || emitted.has(filename) || /\.d\.[cm]?ts$/u.test(filename)) {
      continue;
    }
    const source = program.getSourceFile(filename);
    if (!source) {
      panic(`Missing declaration source: ${filename}`);
    }
    if (isApiRuntimeBoundary(source)) {
      const chain = [filename];
      let parent = parents.get(filename);
      while (parent) {
        chain.unshift(parent);
        parent = parents.get(parent);
      }
      panic(
        `Forbidden API runtime declaration dependency: ${chain.join(" -> ")}`,
      );
    }
    emitted.add(filename);
    const result = program.emit(
      source,
      (output, text) => {
        outputs.set(output, text);
        for (const specifier of typescriptModuleReferences(text, output)
          .imports) {
          const resolved = ts.resolveModuleName(
            specifier,
            filename,
            parsed.options,
            ts.sys,
            resolutionCache,
          ).resolvedModule;
          if (!resolved || /\.d\.[cm]?ts$/u.test(resolved.resolvedFileName)) {
            continue;
          }
          const dependency = program.getSourceFile(resolved.resolvedFileName);
          if (!dependency) {
            panic(
              `Missing declaration dependency: ${specifier} in ${filename}`,
            );
          }
          if (
            !parents.has(dependency.fileName) &&
            !parsed.fileNames.includes(dependency.fileName)
          ) {
            parents.set(dependency.fileName, filename);
          }
          queue.push(dependency.fileName);
        }
      },
      undefined,
      true,
    );
    diagnostics.push(...result.diagnostics);
  }
  if (diagnostics.length > 0) {
    return { diagnostics, files: [...emitted] };
  }
  const missing = missingDeclarationCacheInputs([...emitted], configPath);
  if (missing.length > 0) {
    panic(
      `Emitted API sources missing from declaration cache inputs: ${missing.join(", ")}`,
    );
  }
  // Replace the surface only after serialization succeeds, removing stale
  // declarations for modules that no longer belong to the public surface.
  rmSync(outDir, { recursive: true, force: true });
  for (const [filename, text] of outputs) {
    if (
      !path.resolve(filename).startsWith(`${path.resolve(outDir)}${path.sep}`)
    ) {
      panic(`Declaration output escapes its directory: ${filename}`);
    }
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, text);
  }
  return { diagnostics, files: [...emitted] };
};

// References can require implementation modules that declaration serialization
// erased. Discover those roots from the native consumer programs, rather than
// maintaining a second surface allowlist.
const nativeRequiredDeclarationRoots = (project: string) => {
  const resolved = path.resolve(project);
  const config = ts.sys.realpath?.(resolved) ?? resolved;
  const api = path.dirname(config);
  const root = path.resolve(api, "../..");
  const required = new Set<string>();
  for (const pattern of [
    "tsconfig*.json",
    "apps/*/tsconfig*.json",
    "packages/*/tsconfig*.json",
  ]) {
    for (const filename of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const consumer = path.join(root, filename);
      const read = ts.readConfigFile(consumer, (file) => ts.sys.readFile(file));
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(consumer),
        undefined,
        consumer,
      );
      if (
        !parsed.projectReferences?.some(
          (reference) => ts.resolveProjectReferencePath(reference) === config,
        )
      ) {
        continue;
      }
      const owned = new Set(
        parsed.fileNames.map((file) => ts.sys.realpath?.(file) ?? file),
      );
      for (const source of nativeTypecheckProgramFiles(consumer)) {
        if (
          source.startsWith(`${path.join(api, "src")}${path.sep}`) &&
          /\.[cm]?tsx?$/u.test(source) &&
          !/\.d\.[cm]?ts$/u.test(source) &&
          !owned.has(source)
        ) {
          required.add(source);
        }
      }
    }
  }
  return [...required];
};

export const regenerateApiDeclarationSurface = (project: string) => {
  let result = emitApiTypecheckDeclarations(project);
  while (result.diagnostics.length === 0) {
    const roots = writeApiDeclarationSurface(project, result.files);
    const required = nativeRequiredDeclarationRoots(project);
    const directory = path.dirname(path.resolve(project));
    const api = ts.sys.realpath?.(directory) ?? directory;
    const missing = required.filter(
      (file) => !roots.includes(path.relative(api, file)),
    );
    if (missing.length === 0) {
      return result;
    }
    writeApiDeclarationSurface(project, [...result.files, ...missing]);
    result = emitApiTypecheckDeclarations(project);
  }
  return result;
};

if (import.meta.main) {
  const project = process.argv[2];
  if (!project) {
    panic("Expected API declaration project path");
  }
  const writeSurface = process.argv.includes("--write-surface");
  const { diagnostics, files } = writeSurface
    ? regenerateApiDeclarationSurface(project)
    : emitApiTypecheckDeclarations(project);
  if (diagnostics.length > 0) {
    process.stderr.write(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (filename) => filename,
        getNewLine: () => "\n",
      }),
    );
    process.exit(1);
  }
  if (!writeSurface) {
    const config = ts.readConfigFile(project, (file) => ts.sys.readFile(file));
    const roots = apiDeclarationSurfaceFiles(project, files);
    if (JSON.stringify(config.config.files) !== JSON.stringify(roots)) {
      panic(
        "API declaration roots must match the retained declaration surface; regenerate with --write-surface",
      );
    }
  }
  process.stdout.write(`API declaration surface: ${files.length} modules\n`);
}
