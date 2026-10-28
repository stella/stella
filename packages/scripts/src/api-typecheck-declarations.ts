#!/usr/bin/env bun
import { panic } from "better-result";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { API, formatDiagnosticsWithColorAndContext } from "tsrs/unstable/async";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import {
  apiTypecheckArtifact,
  readApiTypecheckConfig,
  usesGeneratedApiConfig,
  writeApiTypecheckArtifact,
} from "./api-typecheck-config";
import {
  apiResolvedTypecheckInputs,
  nativeTypecheckProgramFiles,
  requireApiTypecheckGeneratedSources,
  uncoveredApiTypecheckFiles,
} from "./api-typecheck-inputs";
import { runHeavyTypecheckWithLock } from "./heavy-typecheck-lock";
import { parseSource, walk } from "./syntax-tree";
import {
  readTurboTypecheckInputs,
  writeTurboTypecheckInputs,
} from "./turbo-typecheck-inputs";
import { createProgram } from "./typescript-program";

// Opt-in timings identify expensive serialization without changing task output.
const declarationProfile = (
  phase: string,
  details: Record<string, string | number>,
) => {
  if (!process.argv.includes("--profile")) {
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

// A JSON module (`resolveJsonModule`) is data: it references no other module.
const JSON_MODULE = /\.json$/iu;

// A tsconfig rewritten here keeps every field it already has.
const TSCONFIG_OBJECT = v.record(v.string(), v.unknown());

export const typescriptModuleReferences = (text: string, filename: string) => {
  const imports = new Set<string>();
  let dynamic = false;
  if (JSON_MODULE.test(filename)) {
    return { imports, dynamic };
  }
  const parsed = parseSource(filename, text);
  walk(parsed.program, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      imports.add(node.source.value);
    }
    if (node.type === "TSImportType") {
      imports.add(node.source.value);
    }
    if (node.type === "TSExternalModuleReference") {
      imports.add(node.expression.value);
    }
    if (
      node.type !== "ImportExpression" &&
      !(
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      )
    ) {
      return;
    }
    const argument =
      node.type === "ImportExpression" ? node.source : node.arguments.at(0);
    if (argument?.type === "Literal" && typeof argument.value === "string") {
      imports.add(argument.value);
    } else if (
      argument?.type === "TemplateLiteral" &&
      argument.expressions.length === 0
    ) {
      imports.add(
        argument.quasis.map(({ value }) => value.cooked ?? value.raw).join(""),
      );
    } else {
      dynamic = true;
    }
  });
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
  const api = existsSync(directory) ? realpathSync(directory) : directory;
  const source = `${path.join(api, "src")}${path.sep}`;
  const roots = [
    ...new Set(
      files
        .map((file) => (existsSync(file) ? realpathSync(file) : file))
        .filter((file) => file.startsWith(source) && /\.[cm]?tsx?$/u.test(file))
        .map((file) => repoRelativePath(api, file)),
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
  if (usesGeneratedApiConfig(configPath)) {
    const artifact = apiTypecheckArtifact(path.dirname(configPath), "roots");
    writeApiTypecheckArtifact(artifact, {
      files: roots.map((file) =>
        repoRelativePath(
          path.dirname(artifact),
          path.resolve(path.dirname(configPath), file),
        ),
      ),
    });
    return roots;
  }
  const config = v.parse(
    TSCONFIG_OBJECT,
    Bun.JSONC.parse(readFileSync(configPath, "utf-8")),
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, files: roots }, null, 2)}\n`,
  );
  return roots;
};

export const missingDeclarationCacheInputs = (
  files: readonly string[],
  project: string,
) => {
  const directory = path.dirname(path.resolve(project));
  const api = existsSync(directory) ? realpathSync(directory) : directory;
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

// Calls that build a route group, the API server, or an MCP server, keyed by
// the module that exports them (relative to apps/api/src for API modules).
const RUNTIME_CONSTRUCTORS: Readonly<Record<string, readonly string[]>> = {
  "http/route": ["routes", "mount"],
  "http/app": ["createHttpApp"],
  "@modelcontextprotocol/server": ["Server"],
};

const constructorModule = (specifier: string, relative: string) => {
  if (specifier.startsWith("@/api/")) {
    return specifier.slice("@/api/".length);
  }
  if (specifier.startsWith(".")) {
    return path.posix.join(path.posix.dirname(relative), specifier);
  }
  return specifier;
};

// Route and server contracts belong to the source checker, never to the
// declaration surface consumed by secondary compiler programs. A module is a
// boundary by its name, or by building routes or a server whatever its name.
const isApiRuntimeBoundary = (filename: string, text: string) => {
  if (JSON_MODULE.test(filename)) {
    return false;
  }
  const relative = filename
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
  const parsed = parseSource(filename, text);
  // Local names bound to a constructor, and namespaces that carry one.
  const constructors = new Set<string>();
  const namespaces = new Map<string, readonly string[]>();
  for (const statement of parsed.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    const names =
      RUNTIME_CONSTRUCTORS[constructorModule(statement.source.value, relative)];
    if (!names) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.set(binding.local.name, names);
      } else if (binding.type === "ImportSpecifier") {
        const imported =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        if (binding.importKind !== "type" && names.includes(imported)) {
          constructors.add(binding.local.name);
        }
      }
    }
  }
  if (constructors.size === 0 && namespaces.size === 0) {
    return false;
  }
  let boundary = false;
  walk(parsed.program, (node) => {
    if (boundary) {
      return "skip-children";
    }
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return undefined;
    }
    const callee = node.callee;
    if (callee.type === "Identifier") {
      boundary = constructors.has(callee.name);
    } else if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.property.type === "Identifier"
    ) {
      boundary =
        namespaces.get(callee.object.name)?.includes(callee.property.name) ??
        false;
    }
    return undefined;
  });
  return boundary;
};

// Emit the explicit public roots and their declaration dependencies. Runtime
// imports erased from declarations do not require serializing their exports.
export const emitApiTypecheckDeclarations = async (project: string) => {
  const configPath = path.resolve(project);
  const compiler = new API({ cwd: path.dirname(configPath) });
  try {
    const parsed = await compiler.parseConfigFile(configPath);
    const diagnostics = [...parsed.errors];
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
    const opened = await createProgram({
      configPath,
      compilerOptions: { declarationMap: false },
    });
    try {
      const { program } = opened;
      declarationProfile("program:end", {
        elapsedMs: Math.round(performance.now() - programStarted),
        sourceFiles: (await program.getSourceFileNames()).length,
      });
      const resolver = await compiler.createModuleResolver(parsed.options);
      const queue = [...parsed.fileNames];
      const parents = new Map<string, string>();
      const emitted = new Set<string>();
      const outputs = new Map<string, string>();
      for (const filename of queue) {
        if (
          !filename ||
          emitted.has(filename) ||
          /\.d\.[cm]?ts$/u.test(filename)
        ) {
          continue;
        }
        const source = await program.getSourceFile(filename);
        if (!source) {
          panic(`Missing declaration source: ${filename}`);
        }
        if (isApiRuntimeBoundary(filename, source.text)) {
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
        const result = await program.getDeclarationEmit([filename]);
        for (const [output, { text }] of result.outputFiles) {
          outputs.set(output, text);
          outputCharacters += text.length;
          for (const specifier of typescriptModuleReferences(text, output)
            .imports) {
            const resolved = (
              await resolver.resolveModuleName(
                specifier,
                path.dirname(filename),
              )
            ).resolvedModule;
            if (!resolved || /\.d\.[cm]?ts$/u.test(resolved.resolvedFileName)) {
              continue;
            }
            const dependency = await program.getSourceFile(
              resolved.resolvedFileName,
            );
            if (!dependency) {
              panic(
                `Missing declaration dependency: ${specifier} in ${filename}`,
              );
            }
            const dependencyName = resolved.resolvedFileName;
            if (
              !parents.has(dependencyName) &&
              !parsed.fileNames.includes(dependencyName)
            ) {
              parents.set(dependencyName, filename);
            }
            queue.push(dependencyName);
          }
        }
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
      if (usesGeneratedApiConfig(configPath)) {
        for (const name of ["roots", "src", "tests"] as const) {
          const artifact = apiTypecheckArtifact(path.dirname(configPath), name);
          const contents = existsSync(artifact)
            ? readFileSync(artifact, "utf-8")
            : undefined;
          if (contents !== undefined) {
            outputs.set(artifact, contents);
          }
        }
      }
      rmSync(outDir, { recursive: true, force: true });
      for (const [filename, text] of outputs) {
        if (
          !path
            .resolve(filename)
            .startsWith(`${path.resolve(outDir)}${path.sep}`)
        ) {
          panic(`Declaration output escapes its directory: ${filename}`);
        }
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, text);
      }
      return { diagnostics, files: [...emitted] };
    } finally {
      await opened.close();
    }
  } finally {
    await compiler.close();
  }
};

// References can require implementation modules that declaration serialization
// erased. Discover those roots from the native consumer programs, rather than
// maintaining a second surface allowlist.
const nativeRequiredDeclarationRoots = async (project: string) => {
  const resolved = path.resolve(project);
  const config = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const api = path.dirname(config);
  const root = path.resolve(api, "../..");
  const compiler = new API({ cwd: api });
  try {
    const required = new Set<string>();
    for (const pattern of [
      "tsconfig*.json",
      "apps/*/tsconfig*.json",
      "packages/*/tsconfig*.json",
    ]) {
      for (const filename of new Bun.Glob(pattern).scanSync({ cwd: root })) {
        const consumer = path.join(root, filename);
        const parsed = await compiler.parseConfigFile(consumer);
        if (
          !parsed.projectReferences?.some(
            (reference) =>
              (reference.path.endsWith(".json")
                ? reference.path
                : path.join(reference.path, "tsconfig.json")) === config,
          )
        ) {
          continue;
        }
        const owned = new Set(
          parsed.fileNames.map((file) =>
            existsSync(file) ? realpathSync(file) : file,
          ),
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
  } finally {
    await compiler.close();
  }
};

// External consumers define the required surface. Test candidates are admitted
// only when their import graph cannot reach a runtime declaration boundary.
export const discoverApiDeclarationEntries = async (project: string) => {
  const absolute = path.resolve(project);
  const config = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const api = path.dirname(config);
  const root = path.resolve(api, "../..");
  const compiler = new API({ cwd: api });
  try {
    const prefix = `${path.join(api, "src")}${path.sep}`;
    const base = await readApiTypecheckConfig(path.join(api, "tsconfig.json"));
    const isSource = (file: string) =>
      file.startsWith(prefix) &&
      /\.[cm]?tsx?$/u.test(file) &&
      !/\.d\.[cm]?ts$/u.test(file);
    const importsOf = async (file: string, options = base.options) => {
      const text = existsSync(file) ? readFileSync(file, "utf-8") : undefined;
      if (text === undefined) {
        panic(`Missing API declaration entry: ${file}`);
      }
      const references = typescriptModuleReferences(text, file);
      const resolver = await compiler.createModuleResolver(options);
      const dependencies = new Set<string>();
      for (const specifier of references.imports) {
        const resolved = (
          await resolver.resolveModuleName(specifier, path.dirname(file))
        ).resolvedModule;
        if (!resolved) {
          continue;
        }
        const filename = realpathSync(resolved.resolvedFileName);
        if (isSource(filename)) {
          dependencies.add(filename);
        }
      }
      return { dependencies, dynamic: references.dynamic, text };
    };
    const entries = new Set<string>();
    for (const pattern of [
      "tsconfig*.json",
      "apps/*/tsconfig*.json",
      "packages/*/tsconfig*.json",
    ]) {
      for (const filename of new Bun.Glob(pattern).scanSync({ cwd: root })) {
        const consumer = path.join(root, filename);
        if (
          consumer === config ||
          consumer === path.join(api, "tsconfig.tests.json")
        ) {
          continue;
        }
        const parsed = await compiler.parseConfigFile(consumer);
        if (
          !parsed.projectReferences?.some(
            (reference) =>
              (reference.path.endsWith(".json")
                ? reference.path
                : path.join(reference.path, "tsconfig.json")) === config,
          )
        ) {
          continue;
        }
        for (const file of parsed.fileNames) {
          for (const dependency of (await importsOf(file, parsed.options))
            .dependencies) {
            entries.add(dependency);
          }
        }
      }
    }
    const candidates = new Set<string>();
    for (const file of base.fileNames.filter((source) =>
      /\.test\.tsx?$/u.test(source),
    )) {
      for (const dependency of (await importsOf(file)).dependencies) {
        if (!/\.test\.tsx?$/u.test(dependency)) {
          candidates.add(dependency);
        }
      }
    }
    const unsafe = new Set<string>();
    const parents = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const queue = [...candidates];
    for (const file of queue) {
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      const info = await importsOf(file);
      if (info.dynamic || isApiRuntimeBoundary(file, info.text)) {
        unsafe.add(file);
        continue;
      }
      for (const dependency of info.dependencies) {
        const predecessors = parents.get(dependency) ?? new Set<string>();
        predecessors.add(file);
        parents.set(dependency, predecessors);
        queue.push(dependency);
      }
    }
    const unsafeQueue = [...unsafe];
    for (const file of unsafeQueue) {
      for (const parent of parents.get(file) ?? []) {
        if (unsafe.has(parent)) {
          continue;
        }
        unsafe.add(parent);
        unsafeQueue.push(parent);
      }
    }
    for (const file of candidates) {
      if (!unsafe.has(file)) {
        entries.add(file);
      }
    }
    return [...entries].toSorted();
  } finally {
    await compiler.close();
  }
};

export const regenerateApiDeclarationSurface = async (
  project: string,
  mode: "prepare" | "update-inputs" = "prepare",
) => {
  if (usesGeneratedApiConfig(project)) {
    const api = path.dirname(path.resolve(project));
    writeApiDeclarationSurface(
      project,
      await discoverApiDeclarationEntries(project),
    );
    for (const name of ["src", "tests"] as const) {
      const artifact = apiTypecheckArtifact(api, name);
      if (!existsSync(artifact)) {
        writeApiTypecheckArtifact(
          artifact,
          name === "tests" ? { files: [] } : {},
        );
      }
    }
  }
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
    const config = v.parse(
      TSCONFIG_OBJECT,
      Bun.JSONC.parse(readFileSync(filename, "utf-8")),
    );
    const roots = v.parse(
      v.object({ files: v.optional(v.array(v.string())) }),
      config,
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
        `${JSON.stringify({ ...config, files }, null, 2)}\n`,
      );
    }
  }
  const refreshInputs = async () => {
    // Preparing ignored compiler artifacts must not mutate the tracked input
    // tree that identifies the shared generated-source artifact.
    if (mode !== "update-inputs") {
      return;
    }
    const turbo = path.resolve(path.dirname(project), "../../turbo.json");
    if (existsSync(turbo)) {
      const inputsStarted = performance.now();
      declarationProfile("inputs:start", { project });
      writeTurboTypecheckInputs(
        turbo,
        new Map([
          [
            "@stll/api#generate:typecheck-declarations",
            await apiResolvedTypecheckInputs(project),
          ],
        ]),
      );
      declarationProfile("inputs:end", {
        project,
        elapsedMs: Math.round(performance.now() - inputsStarted),
      });
    }
  };
  await refreshInputs();
  let iteration = 1;
  declarationProfile("iteration:start", { iteration });
  let result = await emitApiTypecheckDeclarations(project);
  while (result.diagnostics.length === 0) {
    const roots = writeApiDeclarationSurface(project, result.files);
    if (usesGeneratedApiConfig(project)) {
      const { writeApiTestPartition } =
        await import("./api-typecheck-partition");
      await writeApiTestPartition(path.resolve(path.dirname(project), "../.."));
    }
    await refreshInputs();
    const required = await nativeRequiredDeclarationRoots(project);
    const directory = path.dirname(path.resolve(project));
    const api = existsSync(directory) ? realpathSync(directory) : directory;
    declarationProfile("iteration:resolved", {
      iteration,
      emittedModules: result.files.length,
      roots: roots.length,
      requiredRoots: required.length,
    });
    const missing = required.filter(
      (file) => !roots.includes(repoRelativePath(api, file)),
    );
    if (missing.length === 0) {
      return result;
    }
    writeApiDeclarationSurface(project, [...result.files, ...missing]);
    await refreshInputs();
    iteration += 1;
    declarationProfile("iteration:start", { iteration });
    result = await emitApiTypecheckDeclarations(project);
  }
  return result;
};

if (import.meta.main) {
  if (process.env["STELLA_HEAVY_TYPECHECK_LOCK_HELD"] !== "1") {
    const result = await runHeavyTypecheckWithLock({
      command: [process.execPath, import.meta.path, ...process.argv.slice(2)],
      cwd: process.cwd(),
    });
    if (result.type === "wait-timeout") {
      process.stderr.write(
        `api-typecheck-declarations: waited ${String(result.waitSeconds)} s for the host typecheck lock\n`,
      );
      process.exit(1);
    }
    process.exit(result.exitCode);
  }
  const project = process.argv[2];
  if (!project) {
    panic("Expected API declaration project path");
  }
  requireApiTypecheckGeneratedSources(
    path.resolve(path.dirname(path.resolve(project)), "../.."),
  );
  const generated = usesGeneratedApiConfig(project);
  const writeSurface = generated || process.argv.includes("--write-surface");
  const { diagnostics, files } = writeSurface
    ? await regenerateApiDeclarationSurface(
        project,
        process.argv.includes("--write-surface") ? "update-inputs" : "prepare",
      )
    : await emitApiTypecheckDeclarations(project);
  if (diagnostics.length > 0) {
    process.stderr.write(
      formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (filename) => filename,
        getNewLine: () => "\n",
      }),
    );
    process.exit(1);
  }
  if (!writeSurface) {
    const config = Bun.JSONC.parse(readFileSync(project, "utf-8"));
    const roots = apiDeclarationSurfaceFiles(project, files);
    const configured = v.parse(
      v.object({ files: v.array(v.string()) }),
      config,
    ).files;
    if (JSON.stringify(configured) !== JSON.stringify(roots)) {
      const missing = roots.filter((root) => !configured.includes(root));
      const stale = configured.filter((root) => !roots.includes(root));
      panic(
        `API declaration roots must match the retained declaration surface; regenerate with --write-surface (missing=${missing.join(",")}; stale=${stale.join(",")})`,
      );
    }
  }
  process.stdout.write(`API declaration surface: ${files.length} modules\n`);
}
