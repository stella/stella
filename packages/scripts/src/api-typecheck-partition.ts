#!/usr/bin/env bun
import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { typescriptModuleReferences } from "./api-typecheck-declarations";
import { childExitStatus } from "./child-exit-status";
import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

const isTest = (filename: string) => /\.test\.tsx?$/u.test(filename);

const readApiSourceConfig = (root: string) => {
  const api = path.join(root, "apps/api");
  const filename = path.join(api, "tsconfig.json");
  const config = ts.readConfigFile(filename, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    api,
    undefined,
    filename,
  );
  const diagnostics = withoutTsgoOnlyOptionDiagnostics(
    config.error ? [config.error, ...parsed.errors] : parsed.errors,
  );
  if (diagnostics.length > 0) {
    panic(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  }
  return parsed;
};

// Source roots and compiler resolution determine the census. A test is safe to
// isolate only when every reachable API implementation enters declared roots.
export const deriveApiTestPartition = (root: string) => {
  const api = path.join(root, "apps/api");
  const parsed = readApiSourceConfig(root);
  const resolutionCache = ts.createModuleResolutionCache(
    root,
    (file) => file,
    parsed.options,
  );
  const surface: { files: string[] } = JSON.parse(
    readFileSync(path.join(api, "tsconfig.declarations.json"), "utf-8"),
  );
  const declared = new Set(
    surface.files.map((file) => path.resolve(api, file)),
  );
  const testFiles = new Set(parsed.fileNames.filter(isTest));
  const modules = new Map<
    string,
    { dependencies: Set<string>; unsafe: boolean }
  >();
  const moduleInfo = (file: string, mode: "test" | "source" = "test") => {
    const cached = modules.get(file);
    if (cached) {
      return cached;
    }
    const text = readFileSync(file, "utf-8");
    // Source reachability needs only literal imports, which the compiler's
    // preprocessor scans without constructing every implementation AST.
    const imports =
      mode === "source"
        ? {
            imports: new Set(
              ts
                .preProcessFile(text, true, true)
                .importedFiles.map(({ fileName }) => fileName),
            ),
            dynamic: false,
          }
        : typescriptModuleReferences(text, file);
    const dependencies = new Set<string>();
    let unsafe = imports.dynamic;
    for (const specifier of imports.imports) {
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
        resolutionCache,
      ).resolvedModule;
      if (!resolved) {
        if (specifier.startsWith(".") || specifier.startsWith("@/api/")) {
          unsafe = true;
        }
        continue;
      }
      const dependency = path.resolve(resolved.resolvedFileName);
      if (
        dependency.startsWith(`${root}${path.sep}`) &&
        !dependency.includes(`${path.sep}node_modules${path.sep}`) &&
        !/\.d\.[cm]?ts$/u.test(dependency)
      ) {
        dependencies.add(dependency);
      }
    }
    const result = { dependencies, unsafe };
    modules.set(file, result);
    return result;
  };
  const sourceRoot = `${path.join(api, "src")}${path.sep}`;
  const parents = new Map<string, Set<string>>();
  const unsafe = new Set<string>();
  const queue = [...testFiles];
  const visited = new Set<string>();
  for (const file of queue) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const info = moduleInfo(file);
    if (info.unsafe) {
      unsafe.add(file);
    }
    for (const dependency of info.dependencies) {
      if (declared.has(dependency)) {
        continue;
      }
      if (dependency.startsWith(sourceRoot) && !testFiles.has(dependency)) {
        unsafe.add(file);
        continue;
      }
      const predecessors = parents.get(dependency) ?? new Set<string>();
      predecessors.add(file);
      parents.set(dependency, predecessors);
      queue.push(dependency);
    }
  }
  // Propagate unsafe dependencies once through the reverse graph. Cycles are
  // safe only when none of their reachable modules crosses the boundary.
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
  const independent = [...testFiles].filter((file) => !unsafe.has(file));
  const coupled = [...testFiles]
    .filter((file) => unsafe.has(file))
    .map((file) => path.relative(api, file));
  // A safe test imported by source-owned code still belongs to source: exclude
  // every such root from the isolated project, including transitive test imports.
  const isolated = new Set(independent);
  const sourceQueue = parsed.fileNames.filter((file) => !isolated.has(file));
  const visitedSource = new Set<string>();
  for (const file of sourceQueue) {
    if (!file || visitedSource.has(file) || /\.d\.[cm]?ts$/u.test(file)) {
      continue;
    }
    visitedSource.add(file);
    for (const dependency of moduleInfo(file, "source").dependencies) {
      if (isolated.delete(dependency)) {
        coupled.push(path.relative(api, dependency));
      }
      if (
        dependency.startsWith(`${root}${path.sep}`) &&
        !dependency.includes(`${path.sep}node_modules${path.sep}`) &&
        /\.[cm]?tsx?$/u.test(dependency)
      ) {
        sourceQueue.push(dependency);
      }
    }
  }
  return {
    independent: [...isolated]
      .map((file) => path.relative(api, file))
      .toSorted(),
    coupled: coupled.toSorted(),
  };
};

export const apiTestPartitionIssues = (root: string) => {
  const { independent, coupled } = deriveApiTestPartition(root);
  const api = path.join(root, "apps/api");
  const tests: { files?: string[] } = JSON.parse(
    readFileSync(path.join(api, "tsconfig.tests.json"), "utf-8"),
  );
  const source: { exclude?: string[] } = JSON.parse(
    readFileSync(path.join(api, "tsconfig.src.json"), "utf-8"),
  );
  const actual = new Set(tests.files);
  const excluded = new Set(source.exclude);
  const issues: { path: string; message: string }[] = [];
  for (const file of independent) {
    if (!actual.has(file) || !excluded.has(file)) {
      issues.push({
        path: file,
        message:
          "Declaration-safe API test must be owned only by the tests project; regenerate API test partition",
      });
    }
  }
  for (const file of coupled) {
    if (actual.has(file) || excluded.has(file)) {
      issues.push({
        path: file,
        message:
          "Coupled API test must be owned only by source checking; regenerate API test partition",
      });
    }
  }
  for (const file of actual) {
    if (!independent.includes(file)) {
      issues.push({
        path: file,
        message:
          "Tests project has a stale or unsafe root; regenerate API test partition",
      });
    }
  }
  return issues;
};

const checkResolvedApiTestPartition = (root: string) => {
  const api = path.join(root, "apps/api");
  const surface: {
    files: string[];
    compilerOptions: { rootDir: string; outDir: string };
  } = JSON.parse(
    readFileSync(path.join(api, "tsconfig.declarations.json"), "utf-8"),
  );
  for (const file of surface.files) {
    const relative = path.relative(
      path.resolve(api, surface.compilerOptions.rootDir),
      path.resolve(api, file),
    );
    const declaration = path.resolve(
      api,
      surface.compilerOptions.outDir,
      relative.replace(/\.[cm]?tsx?$/u, ".d.ts"),
    );
    if (!existsSync(declaration)) {
      panic(`Missing API declaration for ${file}`);
    }
  }
  const child = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--listFilesOnly",
      "--threads=1",
      "--project",
      path.join(api, "tsconfig.tests.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (childExitStatus(child) !== 0) {
    panic(child.stdout.toString() + child.stderr.toString());
  }
  const files = new Set(
    child.stdout
      .toString()
      .split(/\r?\n/u)
      .filter((file) => path.isAbsolute(file)),
  );
  const { independent, coupled } = deriveApiTestPartition(root);
  const owned = new Set(independent.map((file) => path.resolve(api, file)));
  const sourceChild = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--listFilesOnly",
      "--threads=1",
      "--project",
      path.join(api, "tsconfig.src.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (childExitStatus(sourceChild) !== 0) {
    panic(sourceChild.stdout.toString() + sourceChild.stderr.toString());
  }
  const sourceFiles = new Set(
    sourceChild.stdout
      .toString()
      .split(/\r?\n/u)
      .filter((file) => path.isAbsolute(file)),
  );
  for (const file of coupled) {
    if (!sourceFiles.has(path.resolve(api, file))) {
      panic(`API source program omits coupled test: ${file}`);
    }
  }
  for (const file of owned) {
    if (sourceFiles.has(file)) {
      panic(`API test is checked by both source and tests programs: ${file}`);
    }
  }
  for (const file of owned) {
    if (!files.has(file)) {
      panic(`API tests program omits owned test: ${file}`);
    }
  }
  for (const file of files) {
    if (
      file.startsWith(`${path.join(api, "src")}${path.sep}`) &&
      !/\.d\.[cm]?ts$/u.test(file) &&
      !owned.has(file)
    ) {
      panic(
        `API tests program checks implementation outside its owned roots: ${file}`,
      );
    }
  }
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../../..");
  if (process.argv.includes("--resolved")) {
    checkResolvedApiTestPartition(root);
    process.stdout.write("API tests declaration boundary: ok\n");
    process.exit(0);
  }
  const partition = deriveApiTestPartition(root);
  if (process.argv.includes("--write")) {
    const api = path.join(root, "apps/api");
    const source = JSON.parse(
      readFileSync(path.join(api, "tsconfig.src.json"), "utf-8"),
    );
    source.exclude = [
      "src/mcp/apps",
      "src/handlers/visual-sandbox/browser",
      ...partition.independent,
    ];
    writeFileSync(
      path.join(api, "tsconfig.src.json"),
      `${JSON.stringify(source, null, 2)}\n`,
    );
    const tests = JSON.parse(
      readFileSync(path.join(api, "tsconfig.tests.json"), "utf-8"),
    );
    tests.extends = "./tsconfig.json";
    tests.files = partition.independent;
    tests.include = ["../../types/**/*.d.ts"];
    tests.exclude = ["src/mcp/apps", "src/handlers/visual-sandbox/browser"];
    writeFileSync(
      path.join(api, "tsconfig.tests.json"),
      `${JSON.stringify(tests, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `API test partition: ${partition.independent.length} declaration-safe, ${partition.coupled.length} coupled\n`,
  );
}
