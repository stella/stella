import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { childExitStatus } from "./child-exit-status";
import { CI_GENERATED_OUTPUTS } from "./generated-files";

export const missingApiTypecheckGeneratedSources = (root: string) =>
  [
    ...CI_GENERATED_OUTPUTS.capabilityRuntime,
    ...CI_GENERATED_OUTPUTS.cliRuntime,
  ].filter((file) => !ts.sys.fileExists(path.join(root, file)));

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
  const directory = ts.sys.realpath?.(root) ?? root;
  for (const file of files) {
    const relative = path.relative(directory, ts.sys.realpath?.(file) ?? file);
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
    .map((file) => ts.sys.realpath?.(file) ?? file);
};

// Discovery globs also hash roots added after the last successful compiler run.
export const apiResolvedTypecheckInputs = (project: string) => {
  const config = path.resolve(project);
  const projectDirectory = path.dirname(config);
  const api = ts.sys.realpath?.(projectDirectory) ?? projectDirectory;
  const root = path.resolve(api, "../..");
  const read = ts.readConfigFile(config, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    api,
    undefined,
    config,
  );
  const outputs = [
    parsed.options.outDir,
    parsed.options.declarationDir,
  ].flatMap((directory) => (directory ? [path.resolve(directory)] : []));
  const nativeFiles = nativeTypecheckProgramFiles(config);
  const resolved = nativeFiles.filter(
    (file) =>
      path.isAbsolute(file) &&
      file.startsWith(`${root}${path.sep}`) &&
      !outputs.some((directory) =>
        file.startsWith(`${directory}${path.sep}`),
      ) &&
      !/(?:^|[/\\])(?:node_modules|\.cache|\.turbo)(?:[/\\]|$)/u.test(file),
  );
  const files = new Set(
    resolved.map((file) =>
      file.startsWith(`${api}${path.sep}`)
        ? path.relative(api, file)
        : `$TURBO_ROOT$/${path.relative(root, file)}`,
    ),
  );
  const discovery = v.parse(
    v.object({
      include: v.optional(v.array(v.string())),
      exclude: v.optional(v.array(v.string())),
      files: v.optional(v.array(v.string())),
    }),
    parsed.raw,
  );
  // TypeScript treats a bare directory spec as an implicit recursive glob.
  const discoveryPattern = (spec: string) => {
    const pattern = /[.*?]/u.test(path.basename(spec)) ? spec : `${spec}/**/*`;
    const absolute = path.resolve(api, pattern);
    return absolute.startsWith(`${api}${path.sep}`)
      ? path.relative(api, absolute)
      : `$TURBO_ROOT$/${path.relative(root, absolute)}`;
  };
  const includes = discovery.include ?? (discovery.files ? [] : ["**/*"]);
  for (const include of includes) {
    files.add(discoveryPattern(include));
  }
  const excludes = discovery.exclude ?? [
    "node_modules",
    "bower_components",
    "jspm_packages",
    ...outputs,
  ];
  const resolvedFiles = new Set(resolved);
  for (const exclude of includes.length === 0 ? [] : excludes) {
    const pattern = discoveryPattern(exclude);
    const absolute = pattern.startsWith("$TURBO_ROOT$/")
      ? path.resolve(root, pattern.slice("$TURBO_ROOT$/".length))
      : path.resolve(api, pattern);
    // A root exclusion cannot cancel a concrete imported compiler input.
    const glob = new Bun.Glob(absolute);
    const imported = /[*?]/u.test(absolute)
      ? resolved.some((file) => glob.match(file))
      : resolvedFiles.has(absolute);
    if (!imported) {
      files.add(`!${pattern}`);
    }
  }
  return [
    ...[...files].toSorted(),
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
    "$TURBO_ROOT$/packages/scripts/src/{api-typecheck-*,tsc-native,tsgo-compiler-options,child-exit-status,turbo-typecheck-inputs}.ts",
    "$TURBO_ROOT$/{apps,packages}/**/package.json",
    "!$TURBO_ROOT$/packages/**/.cache/**",
    "!$TURBO_ROOT$/packages/**/.turbo/**",
    "package.json",
    "tsconfig*.json",
  ];
};
