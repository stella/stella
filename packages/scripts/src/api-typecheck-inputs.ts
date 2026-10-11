import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

import { childExitStatus } from "./child-exit-status";

// Root exclusions do not exclude imported modules. Cache the compiler program,
// including workspace dependencies and ambient declarations, instead.
export const apiResolvedTypecheckInputs = (project: string) => {
  const config = path.resolve(project);
  const projectDirectory = path.dirname(config);
  const api = ts.sys.realpath?.(projectDirectory) ?? projectDirectory;
  const root = path.resolve(api, "../..");
  const child = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--no-pretty",
      "--all",
      "--listFilesOnly",
      `--project=${config}`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (childExitStatus(child) !== 0) {
    panic(child.stdout.toString() + child.stderr.toString());
  }
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
  const files = new Set(
    child.stdout
      .toString()
      .split(/\r?\n/u)
      .filter((file) => path.isAbsolute(file))
      .map((file) => ts.sys.realpath?.(file) ?? file)
      .filter(
        (file) =>
          path.isAbsolute(file) &&
          file.startsWith(`${root}${path.sep}`) &&
          !outputs.some((directory) =>
            file.startsWith(`${directory}${path.sep}`),
          ) &&
          !/(?:^|[/\\])(?:node_modules|\.cache|\.turbo)(?:[/\\]|$)/u.test(file),
      )
      .map((file) =>
        file.startsWith(`${api}${path.sep}`)
          ? path.relative(api, file)
          : `$TURBO_ROOT$/${path.relative(root, file)}`,
      ),
  );
  return [
    ...[...files].toSorted(),
    "$TURBO_ROOT$/.npmrc",
    "$TURBO_ROOT$/bunfig.toml",
    "$TURBO_ROOT$/package.json",
    "$TURBO_ROOT$/bun.lock",
    "$TURBO_ROOT$/patches/**",
    "$TURBO_ROOT$/packages/typescript-config/**",
    "$TURBO_ROOT$/packages/scripts/src/{api-typecheck-*,tsc-native,tsgo-compiler-options,child-exit-status,turbo-typecheck-inputs}.ts",
    "$TURBO_ROOT$/{apps,packages}/**/package.json",
    "!$TURBO_ROOT$/packages/**/.cache/**",
    "!$TURBO_ROOT$/packages/**/.turbo/**",
    "package.json",
    "tsconfig*.json",
  ];
};
