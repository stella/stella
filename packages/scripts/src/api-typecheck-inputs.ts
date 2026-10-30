import { panic } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { API } from "tsrs/unstable/async";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  apiDeclarationConsumers,
  usesGeneratedApiConfig,
} from "./api-typecheck-config";
import { childExitStatus } from "./child-exit-status";
import { CI_GENERATED_OUTPUTS } from "./generated-files";

export const missingApiTypecheckGeneratedSources = (root: string) =>
  [
    ...CI_GENERATED_OUTPUTS.capabilityRuntime,
    ...CI_GENERATED_OUTPUTS.cliRuntime,
  ].filter((file) => !existsSync(path.join(root, file)));

export const requireApiTypecheckGeneratedSources = (root: string) => {
  const missing = missingApiTypecheckGeneratedSources(root);
  if (missing.length > 0) {
    panic(
      `Prepare API and CLI generated sources before native typecheck input capture: ${missing.join(", ")}`,
    );
  }
};

export const nativeProgramSpansWorkspaces = (
  files: readonly string[],
  root: string,
) => {
  const workspaces = new Set<string>();
  const directory = realpathSync(root);
  for (const file of files) {
    const relative = repoRelativePath(
      directory,
      existsSync(file) ? realpathSync(file) : file,
    );
    const workspace = /^(?:apps|packages)[/\\][^/\\]+(?=[/\\])/u.exec(
      relative,
    )?.[0];
    if (workspace && !/(?:^|[/\\])node_modules(?:[/\\]|$)/u.test(relative)) {
      workspaces.add(workspace);
    }
  }
  return workspaces.size > 1;
};

// Root exclusions do not exclude imported modules, so cache the resolved program.
export const nativeTypecheckProgramFiles = (project: string) => {
  const config = path.resolve(project);
  const child = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--no-pretty",
      "--all",
      "--listFilesOnly",
      `--project=${config}`,
    ],
    { cwd: path.dirname(config), stdout: "pipe", stderr: "pipe" },
  );
  if (childExitStatus(child) !== 0) {
    panic(child.stdout.toString() + child.stderr.toString());
  }
  return child.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((file) => path.isAbsolute(file))
    .map((file) => (existsSync(file) ? realpathSync(file) : file));
};

// Cover whole workspace roots so adding or moving a file does not rewrite Turbo.
export const apiProgramTypecheckInputs = async (
  project: string,
  nativeFiles: readonly string[],
) => {
  const config = path.resolve(project);
  const directory = path.dirname(config);
  const api = realpathSync(directory);
  const root = path.resolve(api, "../..");
  const roots = new Set(["**"]);
  for (const file of nativeFiles) {
    const relative = repoRelativePath(root, file);
    if (
      relative.startsWith("../") ||
      /(?:^|\/)(?:node_modules|\.cache|\.turbo)(?:\/|$)/u.test(relative)
    ) {
      continue;
    }
    const workspace = /^(?:apps|packages)\/[^/]+(?=\/)/u.exec(relative)?.[0];
    if (workspace === "apps/api") {
      continue;
    }
    const covering = workspace ?? relative.split("/").at(0);
    if (covering) {
      roots.add(
        `$TURBO_ROOT$/${covering}${relative.includes("/") ? "/**" : ""}`,
      );
    }
  }
  const compiler = new API({ cwd: api });
  try {
    const parsed = await compiler.parseConfigFile(config);
    if (
      parsed.options.noCheck &&
      parsed.options.emitDeclarationOnly &&
      usesGeneratedApiConfig(config)
    ) {
      for (const consumer of await apiDeclarationConsumers(config)) {
        for (const file of consumer.fileNames) {
          const relative = repoRelativePath(root, file);
          if (
            relative.startsWith("../") ||
            /(?:^|\/)(?:node_modules|\.cache|\.turbo)(?:\/|$)/u.test(relative)
          ) {
            continue;
          }
          const workspace = /^(?:apps|packages)\/[^/]+(?=\/)/u.exec(
            relative,
          )?.[0];
          if (workspace === "apps/api") {
            continue;
          }
          const covering = workspace ?? relative.split("/").at(0);
          if (covering) {
            roots.add(
              `$TURBO_ROOT$/${covering}${relative.includes("/") ? "/**" : ""}`,
            );
          }
        }
      }
    }
    const outputs = [
      parsed.options.outDir,
      parsed.options.declarationDir,
    ].flatMap((output) =>
      output ? [`!${repoRelativePath(api, path.resolve(output))}/**`] : [],
    );
    return [
      ...new Set([
        ...[...roots].toSorted(),
        "$TURBO_ROOT$/.npmrc",
        "$TURBO_ROOT$/bunfig.toml",
        "$TURBO_ROOT$/package.json",
        ...(nativeProgramSpansWorkspaces(nativeFiles, root)
          ? ["$TURBO_ROOT$/bun.lock"]
          : []),
        "$TURBO_ROOT$/patches/**",
        "$TURBO_ROOT$/types/**",
        "$TURBO_ROOT$/packages/typescript-config/**",
        "$TURBO_ROOT$/packages/scripts/src/generated-files.ts",
        "$TURBO_ROOT$/packages/scripts/src/{api-typecheck-*,tsc-native,child-exit-status,turbo-typecheck-inputs}.ts",
        "$TURBO_ROOT$/{apps,packages}/**/package.json",
        "$TURBO_ROOT$/tsconfig*.json",
        "$TURBO_ROOT$/{apps,packages}/*/tsconfig*.json",
        "!$TURBO_ROOT$/{apps,packages}/**/node_modules/**",
        "!$TURBO_ROOT$/{apps,packages}/**/.cache/**",
        "!$TURBO_ROOT$/{apps,packages}/**/.turbo/**",
        "!node_modules/**",
        "!.cache/**",
        "!.turbo/**",
        ...outputs,
        "package.json",
        "tsconfig*.json",
      ]),
    ];
  } finally {
    await compiler.close();
  }
};

export const apiResolvedTypecheckInputs = async (project: string) =>
  await apiProgramTypecheckInputs(
    project,
    nativeTypecheckProgramFiles(project),
  );

type ApiTypecheckCoverageOptions = {
  files: readonly string[];
  inputs: readonly string[];
  project: string;
};

export const uncoveredApiTypecheckFiles = ({
  files,
  inputs,
  project,
}: ApiTypecheckCoverageOptions) => {
  const directory = path.dirname(path.resolve(project));
  const api = realpathSync(directory);
  const root = path.resolve(api, "../..");
  const patterns = inputs.map((input) => {
    const excluded = input.startsWith("!");
    const pattern = excluded ? input.slice(1) : input;
    return {
      excluded,
      directory: pattern.startsWith("$TURBO_ROOT$/") ? root : api,
      glob: new Bun.Glob(pattern.replace("$TURBO_ROOT$/", "")),
    };
  });
  return files.filter((file) => {
    const resolved = existsSync(file) ? realpathSync(file) : file;
    const matches = patterns.filter(
      (pattern) =>
        isPathInside(pattern.directory, resolved) &&
        pattern.glob.match(repoRelativePath(pattern.directory, resolved)),
    );
    return (
      !matches.some((pattern) => !pattern.excluded) ||
      matches.some((pattern) => pattern.excluded)
    );
  });
};
