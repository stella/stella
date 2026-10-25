import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { API } from "tsrs/unstable/async";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import {
  nativeProgramSpansWorkspaces,
  nativeTypecheckProgramFiles,
} from "./api-typecheck-inputs";
import { apiTypecheckProjects } from "./api-typecheck-partition";

const typecheckCacheTaskSchema = v.looseObject({
  cache: v.optional(v.boolean()),
  inputs: v.optional(v.array(v.string())),
  outputs: v.optional(v.array(v.string())),
  dependsOn: v.optional(v.array(v.string())),
});
type CacheTask = v.InferOutput<typeof typecheckCacheTaskSchema>;

export const TYPECHECK_CACHE_INPUTS = [
  "$TURBO_DEFAULT$",
  "$TURBO_ROOT$/.npmrc",
  "$TURBO_ROOT$/bunfig.toml",
  "$TURBO_ROOT$/package.json",
  "$TURBO_ROOT$/packages/typescript-config/**",
  "$TURBO_ROOT$/patches/**",
  "$TURBO_ROOT$/types/**",
];
const isTypecheckTask = (name: string) => /(?:^|#)typecheck(?::|$)/u.test(name);
export const readTypecheckCacheTasks = (root: string) =>
  Object.entries(
    v.parse(
      v.object({ tasks: v.record(v.string(), typecheckCacheTaskSchema) }),
      Bun.JSONC.parse(readFileSync(path.join(root, "turbo.json"), "utf-8")),
    ).tasks,
  ).filter(([name]) => isTypecheckTask(name));

export const nativeProjectsForCommand = (command: string, directory: string) =>
  command
    .split("&&")
    .filter((part) => /\bbun\s+check\b/u.test(part))
    .flatMap((part) => [
      ...part.matchAll(/--project(?:=|\s+)(["']?)([^\s"';]+)\1/gu),
    ])
    .flatMap((match) => (match[2] ? [path.resolve(directory, match[2])] : []));

export const explicitTypecheckProjects = (root: string) => {
  const api = path.join(root, "apps/api");
  const projects = existsSync(path.join(api, "package.json"))
    ? apiTypecheckProjects(api)
    : new Map<string, string>();
  const manifests = new Map<
    string,
    { directory: string; scripts: Record<string, string> }
  >();
  for (const file of new Bun.Glob("{apps,packages}/*/package.json").scanSync({
    cwd: root,
  })) {
    const manifest = v.parse(
      v.object({
        name: v.string(),
        scripts: v.optional(v.record(v.string(), v.string()), {}),
      }),
      JSON.parse(readFileSync(path.join(root, file), "utf-8")),
    );
    manifests.set(manifest.name, {
      directory: path.dirname(path.join(root, file)),
      scripts: manifest.scripts,
    });
  }
  const result = new Map<string, string[]>();
  for (const [name] of readTypecheckCacheTasks(root)) {
    const canonical = projects.get(name);
    if (canonical) {
      result.set(name, [canonical]);
      continue;
    }
    const [workspace, task] = name.split("#");
    const manifest = workspace ? manifests.get(workspace) : undefined;
    const command = task ? manifest?.scripts[task] : undefined;
    if (!manifest || !command) {
      continue;
    }
    const configs = nativeProjectsForCommand(command, manifest.directory);
    if (configs.length > 0) {
      result.set(name, configs);
    }
  }
  return result;
};

type CacheContractOptions = {
  name: string;
  task: CacheTask;
  crossWorkspacePrograms?: ReadonlySet<string>;
  resolvedInputPrograms?: ReadonlySet<string>;
};
export const resolvedTypecheckCachePrograms = (root: string) => {
  const api = path.join(root, "apps/api");
  return new Set(
    existsSync(path.join(api, "package.json"))
      ? apiTypecheckProjects(api).keys()
      : [],
  );
};

export const typecheckCacheStructuralProblems = (
  task: CacheTask,
  programInputs: "workspace" | "resolved" = "workspace",
) => [
  ...(task.cache === true ? [] : ["must explicitly enable caching"]),
  ...TYPECHECK_CACHE_INPUTS.filter(
    (input) => input !== "$TURBO_DEFAULT$" || programInputs === "workspace",
  )
    .filter(
      (input) =>
        !task.inputs?.some(
          (pattern) =>
            !pattern.startsWith("!") && new Bun.Glob(pattern).match(input),
        ) ||
        task.inputs.some(
          (pattern) =>
            pattern.startsWith("!") &&
            new Bun.Glob(pattern.slice(1)).match(input),
        ),
    )
    .map((input) => `missing input ${input}`),
  ...(task.outputs === undefined ? ["must declare outputs"] : []),
];
export const typecheckCacheProblems = ({
  name,
  task,
  crossWorkspacePrograms = new Set(),
  resolvedInputPrograms = new Set(),
}: CacheContractOptions) => [
  ...typecheckCacheStructuralProblems(
    task,
    resolvedInputPrograms.has(name) ? "resolved" : "workspace",
  ),
  ...((name.startsWith("//#") || crossWorkspacePrograms.has(name)) &&
  !task.inputs?.includes("$TURBO_ROOT$/bun.lock")
    ? ["root and cross-workspace programs must hash the full lockfile"]
    : []),
  ...(!name.startsWith("//#") &&
  !crossWorkspacePrograms.has(name) &&
  task.inputs?.includes("$TURBO_ROOT$/bun.lock")
    ? ["must let Turbo hash relevant lock entries"]
    : []),
];

const readCompilerProject = async (project: string) => {
  const compiler = new API({ cwd: path.dirname(project) });
  try {
    const parsed = await compiler.parseConfigFile(project);
    if (parsed.errors.length > 0) {
      panic(parsed.errors.map(({ text }) => text).join("\n"));
    }
    return parsed;
  } finally {
    await compiler.close();
  }
};

const assertReferenceDeclarations = async (project: string) => {
  const parsed = await readCompilerProject(project);
  if (!parsed.options.disableSourceOfProjectReferenceRedirect) {
    return;
  }
  for (const reference of parsed.projectReferences ?? []) {
    const config = reference.path.endsWith(".json")
      ? reference.path
      : path.join(reference.path, "tsconfig.json");
    const producer = await readCompilerProject(config);
    const directories = producer.fileNames
      .filter((file) => !/\.d\.[cm]?ts$/u.test(file))
      .map((file) => path.dirname(file));
    let common = directories.at(0) ?? path.dirname(config);
    for (const directory of directories) {
      while (
        directory !== common &&
        !directory.startsWith(`${common}${path.sep}`)
      ) {
        common = path.dirname(common);
      }
    }
    const sourceRoot =
      producer.options.rootDir ??
      (producer.options.composite ? path.dirname(config) : common);
    const outputRoot =
      producer.options.declarationDir ?? producer.options.outDir;
    for (const source of producer.fileNames) {
      if (/\.d\.[cm]?ts$/u.test(source) || !/\.[cm]?tsx?$/u.test(source)) {
        continue;
      }
      const output = (
        outputRoot
          ? path.join(outputRoot, repoRelativePath(sourceRoot, source))
          : source
      ).replace(/\.(?:tsx?|mts|cts)$/u, (extension) => {
        if (extension === ".mts") {
          return ".d.mts";
        }
        if (extension === ".cts") {
          return ".d.cts";
        }
        return ".d.ts";
      });
      if (!existsSync(output)) {
        panic(
          `Prepare declaration output before native cache audit: ${output}`,
        );
      }
    }
  }
};

export const typecheckCacheCrossWorkspacePrograms = async (root: string) => {
  const crossWorkspacePrograms = new Set<string>();
  const filesByProject = new Map<string, string[]>();
  for (const [name, projects] of explicitTypecheckProjects(root)) {
    const files = (
      await Promise.all(
        projects.map(async (project) => {
          const existing = filesByProject.get(project);
          if (existing) {
            return existing;
          }
          await assertReferenceDeclarations(project);
          const resolved = nativeTypecheckProgramFiles(project);
          filesByProject.set(project, resolved);
          return resolved;
        }),
      )
    ).flat();
    if (nativeProgramSpansWorkspaces(files, root)) {
      crossWorkspacePrograms.add(name);
    }
  }
  return crossWorkspacePrograms;
};

export const typecheckCacheContractIssues = async (
  root: string,
  crossWorkspacePrograms?: ReadonlySet<string>,
) => {
  const crossWorkspace =
    crossWorkspacePrograms ??
    (await typecheckCacheCrossWorkspacePrograms(root));
  const resolvedInputPrograms = resolvedTypecheckCachePrograms(root);
  return readTypecheckCacheTasks(root).flatMap(([name, task]) =>
    typecheckCacheProblems({
      name,
      task,
      crossWorkspacePrograms: crossWorkspace,
      resolvedInputPrograms,
    }).map((problem) => `${name}: ${problem}`),
  );
};
