#!/usr/bin/env bun
import { panic } from "better-result";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API } from "tsrs/unstable/async";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import {
  apiTypecheckArtifact,
  readApiTypecheckConfig,
  usesGeneratedApiConfig,
  writeApiTypecheckArtifact,
} from "./api-typecheck-config";
import { typescriptModuleReferences } from "./api-typecheck-declarations";
import {
  apiProgramTypecheckInputs,
  apiResolvedTypecheckInputs,
  nativeTypecheckProgramFiles,
  requireApiTypecheckGeneratedSources,
  uncoveredApiTypecheckFiles,
} from "./api-typecheck-inputs";
import {
  readTurboTypecheckInputs,
  writeTurboTypecheckInputs,
} from "./turbo-typecheck-inputs";

const isTest = (filename: string) => /\.test\.tsx?$/u.test(filename);

const readApiSourceConfig = async (root: string) =>
  await readApiTypecheckConfig(path.join(root, "apps/api/tsconfig.json"));

// Source roots and compiler resolution determine the census. A test is safe to
// isolate only when every reachable API implementation enters declared roots.
export const deriveApiTestPartition = async (directory: string) => {
  const root = realpathSync(directory);
  const api = path.join(root, "apps/api");
  const parsed = await readApiSourceConfig(root);
  const compiler = new API({ cwd: root });
  try {
    const resolver = await compiler.createModuleResolver(parsed.options);
    const surface = await readApiTypecheckConfig(
      path.join(api, "tsconfig.declarations.json"),
    );
    const declared = new Set(surface.fileNames);
    const testFiles = new Set(parsed.fileNames.filter(isTest));
    const modules = new Map<
      string,
      { dependencies: Set<string>; unsafe: boolean }
    >();
    const moduleInfo = async (
      file: string,
      mode: "test" | "source" = "test",
    ) => {
      const cached = modules.get(file);
      if (cached) {
        return cached;
      }
      const text = readFileSync(file, "utf-8");
      // Source reachability needs only literal imports, which the compiler's
      // preprocessor scans without constructing every implementation AST.
      const references = typescriptModuleReferences(text, file);
      const imports =
        mode === "source"
          ? { imports: references.imports, dynamic: false }
          : references;
      const dependencies = new Set<string>();
      let unsafe = imports.dynamic;
      for (const specifier of imports.imports) {
        const resolved = (
          await resolver.resolveModuleName(specifier, path.dirname(file))
        ).resolvedModule;
        if (!resolved) {
          if (specifier.startsWith(".") || specifier.startsWith("@/api/")) {
            unsafe = true;
          }
          continue;
        }
        const resolvedFile = path.resolve(resolved.resolvedFileName);
        const dependency = realpathSync(resolvedFile);
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
      const info = await moduleInfo(file);
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
      .map((file) => repoRelativePath(api, file));
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
      for (const dependency of (await moduleInfo(file, "source"))
        .dependencies) {
        if (isolated.delete(dependency)) {
          coupled.push(repoRelativePath(api, dependency));
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
        .map((file) => repoRelativePath(api, file))
        .toSorted(),
      coupled: coupled.toSorted(),
    };
  } finally {
    await compiler.close();
  }
};

export const apiTypecheckProjects = (api: string) => {
  const manifest = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(readFileSync(path.join(api, "package.json"), "utf-8")),
  );
  const programs = new Map<string, string>();
  for (const [task, command] of Object.entries(manifest.scripts)) {
    if (
      !task.startsWith("typecheck:") &&
      !command.includes("/api-typecheck-declarations.ts ")
    ) {
      continue;
    }
    const project =
      /--project(?:=|\s+)([^\s]+)/u.exec(command)?.[1] ??
      /\b(tsconfig[^\s]*\.json)\s*$/u.exec(command)?.[1];
    if (!project) {
      panic(`API typecheck task has no compiler project: ${task}`);
    }
    programs.set(`@stll/api#${task}`, path.resolve(api, project));
  }
  return programs;
};

const apiProjectInputs = async (api: string) =>
  new Map(
    await Promise.all(
      [...apiTypecheckProjects(api)].map(
        async ([task, project]) =>
          [task, await apiResolvedTypecheckInputs(project)] as const,
      ),
    ),
  );

export const apiTestPartitionIssues = async (root: string) => {
  const { independent, coupled } = await deriveApiTestPartition(root);
  const api = path.join(root, "apps/api");
  const testsProject = path.join(api, "tsconfig.tests.json");
  const sourceProject = path.join(api, "tsconfig.src.json");
  const actual = new Set(
    (await readApiTypecheckConfig(testsProject)).fileNames
      .map((file) => repoRelativePath(api, file))
      .filter((file) => !/\.d\.[cm]?ts$/u.test(file)),
  );
  const sourceFiles = new Set(
    (await readApiTypecheckConfig(sourceProject)).fileNames.map((file) =>
      repoRelativePath(api, file),
    ),
  );
  const excluded = new Set(
    [...independent, ...coupled].filter((file) => !sourceFiles.has(file)),
  );
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

export const apiTypecheckInputIssues = async (
  root: string,
  programs = new Map(
    [...apiTypecheckProjects(path.join(root, "apps/api"))].map(
      ([task, project]) => [task, nativeTypecheckProgramFiles(project)],
    ),
  ),
) => {
  const directory = realpathSync(root);
  const issues: { path: string; message: string }[] = [];
  const turbo = readTurboTypecheckInputs(path.join(root, "turbo.json"));
  const projects = apiTypecheckProjects(path.join(root, "apps/api"));
  for (const [task, files] of programs) {
    const project = projects.get(task);
    if (!project) {
      panic(`Missing API compiler project: ${task}`);
    }
    const inputs = turbo.tasks[task]?.inputs ?? [];
    const expected = await apiProgramTypecheckInputs(project, files);
    const required = expected.filter((input) => !input.startsWith("!"));
    const sources = files.filter(
      (file) =>
        file.startsWith(`${directory}${path.sep}`) &&
        !/(?:^|[/\\])(?:node_modules|\.cache|\.turbo)(?:[/\\]|$)/u.test(file),
    );
    // Stable covering roots are also discovery inputs for not-yet-existing files.
    const missing = required.some((input) => !inputs.includes(input));
    const excludesSource = inputs.some(
      (input) => input.startsWith("!") && !expected.includes(input),
    );
    const witnesses = required
      .filter((input) => !input.includes("{"))
      .map((input) =>
        path.resolve(
          input.startsWith("$TURBO_ROOT$/")
            ? directory
            : path.join(directory, "apps/api"),
          input
            .replace("$TURBO_ROOT$/", "")
            .replaceAll("**", "__new_root__")
            .replaceAll("*", "example"),
        ),
      );
    if (
      missing ||
      excludesSource ||
      uncoveredApiTypecheckFiles({
        files: [...sources, ...witnesses],
        inputs,
        project,
      }).length > 0
    ) {
      issues.push({
        path: "turbo.json",
        message: `${task} cache inputs must cover the native resolved program and workspace discovery; regenerate API test partition`,
      });
    }
  }
  return issues;
};

type DeclarationOutputNameOptions = { source: string; outFile?: string };
const declarationOutputName = ({
  source,
  outFile,
}: DeclarationOutputNameOptions) => {
  if (outFile) {
    return `${outFile.replace(/\.[^./\\]+$/u, "")}.d.ts`;
  }
  return source.replace(/\.(?:[jt]sx?|[mc][jt]s)$/u, (extension) => {
    if (extension === ".mts" || extension === ".mjs") {
      return ".d.mts";
    }
    if (extension === ".cts" || extension === ".cjs") {
      return ".d.cts";
    }
    return ".d.ts";
  });
};

const checkResolvedApiTestPartition = async (root: string) => {
  const api = path.join(root, "apps/api");
  const programs = new Map(
    [...apiTypecheckProjects(api)].map(([task, project]) => [
      task,
      nativeTypecheckProgramFiles(project),
    ]),
  );
  const inputIssues = await apiTypecheckInputIssues(root, programs);
  if (inputIssues.length > 0) {
    panic(inputIssues.map(({ message }) => message).join("\n"));
  }

  const surface = await readApiTypecheckConfig(
    path.join(api, "tsconfig.declarations.json"),
  );
  const outputRoot = surface.options.declarationDir ?? surface.options.outDir;
  const directories = surface.fileNames
    .filter((source) => !/\.d\.[cm]?ts$/u.test(source))
    .map((source) => path.dirname(source));
  let common = directories.at(0) ?? api;
  for (const directory of directories) {
    while (
      common !== path.parse(common).root &&
      directory !== common &&
      !directory.startsWith(`${common}${path.sep}`)
    ) {
      common = path.dirname(common);
    }
  }
  const sourceRoot =
    surface.options.rootDir ?? (surface.options.composite ? api : common);
  for (const file of surface.fileNames.filter(
    (source) => !/\.d\.[cm]?ts$/u.test(source),
  )) {
    const declaration = declarationOutputName({
      source: outputRoot
        ? path.join(outputRoot, repoRelativePath(sourceRoot, file))
        : file,
      outFile: surface.options.outFile,
    });
    if (!existsSync(declaration)) {
      panic(`Missing API declaration for ${file}`);
    }
  }
  const programFiles = (task: string) =>
    new Set(
      (programs.get(task) ?? []).filter((file) => /\.[cm]?tsx?$/u.test(file)),
    );
  const files = programFiles("@stll/api#typecheck:tests");
  const { independent, coupled } = await deriveApiTestPartition(root);
  const owned = new Set(independent.map((file) => path.resolve(api, file)));
  const sourceFiles = programFiles("@stll/api#typecheck:src");
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

export const writeApiTestPartition = async (root: string) => {
  const api = path.join(root, "apps/api");
  const partition = await deriveApiTestPartition(root);
  const project = path.join(api, "tsconfig.declarations.json");
  if (usesGeneratedApiConfig(project)) {
    const source = apiTypecheckArtifact(api, "src");
    const tests = apiTypecheckArtifact(api, "tests");
    const relative = (file: string) =>
      repoRelativePath(path.dirname(source), path.resolve(api, file));
    writeApiTypecheckArtifact(source, {
      files: [],
      include: ["src", "drizzle.config.ts", "../../types"].map(relative),
      exclude: [
        "src/handlers/visual-sandbox/browser",
        ...partition.independent,
      ].map(relative),
    });
    writeApiTypecheckArtifact(tests, {
      files: partition.independent.map(relative),
      include: [
        repoRelativePath(
          path.dirname(tests),
          path.join(root, "types/**/*.d.ts"),
        ),
      ],
      exclude: ["src/handlers/visual-sandbox/browser"].map(relative),
    });
    return partition;
  }
  const sourceFile = path.join(api, "tsconfig.src.json");
  const testsFile = path.join(api, "tsconfig.tests.json");
  const source = JSON.parse(readFileSync(sourceFile, "utf-8"));
  source.exclude = [
    "src/handlers/visual-sandbox/browser",
    ...partition.independent,
  ];
  writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
  const tests = JSON.parse(readFileSync(testsFile, "utf-8"));
  tests.extends = "./tsconfig.json";
  tests.files = partition.independent;
  tests.include = ["../../types/**/*.d.ts"];
  tests.exclude = ["src/handlers/visual-sandbox/browser"];
  writeFileSync(testsFile, `${JSON.stringify(tests, null, 2)}\n`);
  return partition;
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../../..");
  requireApiTypecheckGeneratedSources(root);
  if (process.argv.includes("--resolved")) {
    await checkResolvedApiTestPartition(root);
    process.stdout.write("API tests declaration boundary: ok\n");
    process.exit(0);
  }
  const partition = await deriveApiTestPartition(root);
  if (process.argv.includes("--write")) {
    await writeApiTestPartition(root);
    const api = path.join(root, "apps/api");
    writeTurboTypecheckInputs(
      path.join(root, "turbo.json"),
      await apiProjectInputs(api),
    );
  }
  process.stdout.write(
    `API test partition: ${partition.independent.length} declaration-safe, ${partition.coupled.length} coupled\n`,
  );
}
