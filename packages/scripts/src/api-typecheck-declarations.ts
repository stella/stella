#!/usr/bin/env bun
import { panic } from "better-result";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

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
    /(?:^|[-/])(?:routes?|server)(?:[-.]|$)/u.test(relative)
  ) {
    return true;
  }
  const constructors = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "elysia"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name) {
      constructors.add(clause.name.text);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === "Elysia") {
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

if (import.meta.main) {
  const project = process.argv[2];
  if (!project) {
    panic("Expected API declaration project path");
  }
  const { diagnostics, files } = emitApiTypecheckDeclarations(project);
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
  process.stdout.write(`API declaration surface: ${files.length} modules\n`);
}
