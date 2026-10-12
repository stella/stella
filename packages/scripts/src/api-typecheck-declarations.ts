#!/usr/bin/env bun
import { panic } from "better-result";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import {
  apiResolvedTypecheckInputs,
  uncoveredApiTypecheckFiles,
  nativeTypecheckProgramFiles,
  requireApiTypecheckGeneratedSources,
} from "./api-typecheck-inputs";
import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";
import {
  readTurboTypecheckInputs,
  writeTurboTypecheckInputs,
} from "./turbo-typecheck-inputs";

// Opt-in timings identify expensive serialization without changing task output.
const declarationProfile = (
  phase: string,
  details: Record<string, string | number>,
) => {
  if (process.env["API_TYPECHECK_DECLARATIONS_PROFILE"] !== "1") {
    return;
  }
  process.stderr.write(
    `${JSON.stringify({
      phase,
      ...details,
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    })}\n`,
  );
};

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
  const inputs =
    config.tasks["@stll/api#generate:typecheck-declarations"]?.inputs ?? [];
  return uncoveredApiTypecheckFiles({ files, inputs, project });
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
  const programStarted = performance.now();
  declarationProfile("program:start", { roots: parsed.fileNames.length });
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, declarationMap: false },
  });
  declarationProfile("program:end", {
    elapsedMs: Math.round(performance.now() - programStarted),
    sourceFiles: program.getSourceFiles().length,
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
    const emitStarted = performance.now();
    let outputCharacters = 0;
    declarationProfile("file:start", { filename });
    const result = program.emit(
      source,
      (output, text) => {
        outputs.set(output, text);
        outputCharacters += text.length;
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
    declarationProfile("file:end", {
      filename,
      elapsedMs: Math.round(performance.now() - emitStarted),
      outputCharacters,
      diagnostics: result.diagnostics.length,
    });
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
      const consumerStarted = performance.now();
      declarationProfile("consumer:start", { project: consumer });
      const sources = nativeTypecheckProgramFiles(consumer);
      declarationProfile("consumer:end", {
        project: consumer,
        elapsedMs: Math.round(performance.now() - consumerStarted),
        sourceFiles: sources.length,
      });
      for (const source of sources) {
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
  // Generated explicit roots can outlive a deleted or moved source file.
  // Prune those stale roots before native resolution; the following census
  // and dependency closure derive the replacement owners and declarations.
  for (const filename of [
    path.resolve(project),
    path.resolve(path.dirname(project), "tsconfig.tests.json"),
  ]) {
    if (!existsSync(filename)) {
      continue;
    }
    const config = ts.readConfigFile(filename, (file) => ts.sys.readFile(file));
    const roots = v.parse(
      v.object({ files: v.optional(v.array(v.string())) }),
      config.config,
    ).files;
    if (!roots) {
      continue;
    }
    const files = roots.filter((file) =>
      existsSync(path.resolve(path.dirname(filename), file)),
    );
    if (files.length !== roots.length) {
      writeFileSync(
        filename,
        `${JSON.stringify({ ...config.config, files }, null, 2)}\n`,
      );
    }
  }
  const refreshInputs = () => {
    const turbo = path.resolve(path.dirname(project), "../../turbo.json");
    if (existsSync(turbo)) {
      const inputsStarted = performance.now();
      declarationProfile("inputs:start", { project });
      writeTurboTypecheckInputs(
        turbo,
        new Map([
          [
            "@stll/api#generate:typecheck-declarations",
            apiResolvedTypecheckInputs(project),
          ],
        ]),
      );
      declarationProfile("inputs:end", {
        project,
        elapsedMs: Math.round(performance.now() - inputsStarted),
      });
    }
  };
  refreshInputs();
  let iteration = 1;
  declarationProfile("iteration:start", { iteration });
  let result = emitApiTypecheckDeclarations(project);
  while (result.diagnostics.length === 0) {
    const roots = writeApiDeclarationSurface(project, result.files);
    refreshInputs();
    const required = nativeRequiredDeclarationRoots(project);
    const directory = path.dirname(path.resolve(project));
    const api = ts.sys.realpath?.(directory) ?? directory;
    declarationProfile("iteration:resolved", {
      iteration,
      emittedModules: result.files.length,
      roots: roots.length,
      requiredRoots: required.length,
    });
    const missing = required.filter(
      (file) => !roots.includes(path.relative(api, file)),
    );
    if (missing.length === 0) {
      return result;
    }
    writeApiDeclarationSurface(project, [...result.files, ...missing]);
    refreshInputs();
    iteration += 1;
    declarationProfile("iteration:start", { iteration });
    result = emitApiTypecheckDeclarations(project);
  }
  return result;
};

if (import.meta.main) {
  const project = process.argv[2];
  if (!project) {
    panic("Expected API declaration project path");
  }
  requireApiTypecheckGeneratedSources(
    path.resolve(path.dirname(path.resolve(project)), "../.."),
  );
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
