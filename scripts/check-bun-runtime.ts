/**
 * Every JavaScript process a package script starts runs on Bun, the runtime
 * the service images run (`CMD ["bun", …]` in apps/web/Dockerfile and
 * apps/api/Dockerfile).
 *
 * npm executables start with `#!/usr/bin/env node`, so a bare `vite` in a
 * package script starts Node even under `bun run`. `bun --bun <bin>` runs the
 * executable, and every `node` it spawns, on Bun. A bunfig.toml
 * `[run] bun = true` does not cover this: Bun reads it only from the directory
 * a command starts in, and the dev runner and turbo start package scripts
 * from the package directory.
 */
import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { guardEnforcesLine } from "./guard-rollouts";
import { lexShell, programWords } from "./install-free-ci";

const ROOT = path.resolve(import.meta.dir, "..");
const GUARD = "bun-runtime-scripts";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const BUN = "bun";
const NODE = "node";
/** Programs that are Node itself or start Node regardless of the executable. */
const NODE_PROGRAMS = new Set([NODE, "npx", "npm"]);
const BUN_RUNTIME_FLAGS = new Set(["--bun", "-b"]);

/**
 * Executables that stay on Node, with the failure that keeps them there.
 * An entry no package script uses fails the check, so the list only shrinks.
 */
export const NODE_RUNTIME_EXCEPTIONS: Readonly<Record<string, string>> = {};

export type Runtime = typeof BUN | typeof NODE;

export type Launch = {
  /** The executable or program the command starts. */
  program: string;
  runtime: Runtime;
};

const SHEBANG = /^#!.*\bnode\b/u;
const BIN_BLOCK = /"bin": \{([^}]*)\}/gu;
const BIN_NAME = /"([^"]+)":/gu;

/**
 * Names of every package executable that starts Node: registry packages
 * from bun.lock, and workspace executables unless their shebang names
 * another runtime.
 */
export const packageExecutables = (root: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const lockfile = readFileSync(path.join(root, "bun.lock"), "utf-8");
  for (const [, block = ""] of lockfile.matchAll(BIN_BLOCK)) {
    for (const [, name = ""] of block.matchAll(BIN_NAME)) {
      names.add(name);
    }
  }
  for (const directory of workspaceDirectories(root)) {
    const manifest = readManifest(path.join(root, directory, "package.json"));
    // An unbuilt executable counts as Node, the npm default.
    for (const [name, file] of binEntries(manifest)) {
      const source = path.join(root, directory, String(file));
      if (
        !existsSync(source) ||
        SHEBANG.test(readFileSync(source, "utf-8").split("\n", 1)[0] ?? "")
      ) {
        names.add(name);
      }
    }
  }
  return names;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A manifest's executables: a string `bin` is named after the package. */
const binEntries = (manifest: Record<string, unknown>): [string, unknown][] => {
  const bin = manifest["bin"];
  if (typeof bin === "string") {
    return [[String(manifest["name"]).split("/").at(-1) ?? "", bin]];
  }
  return isRecord(bin) ? Object.entries(bin) : [];
};

const readManifest = (file: string): Record<string, unknown> => {
  const manifest: unknown = JSON.parse(readFileSync(file, "utf-8"));
  return isRecord(manifest) ? manifest : panic(`${file} is not an object`);
};

const workspaceDirectories = (root: string): string[] =>
  WORKSPACE_PARENTS.flatMap((parent) =>
    readdirSync(path.join(root, parent), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(root, parent, entry.name, "package.json")),
      )
      .map((entry) => `${parent}/${entry.name}`)
      .toSorted(),
  );

/** What runs an executable `bunx` or `bun x` fetches: Bun only with `--bun`. */
const bunxLaunch = (words: readonly string[]): Launch[] => {
  const forced = BUN_RUNTIME_FLAGS.has(words.at(0) ?? "");
  const program = (forced ? words.slice(1) : words).find(
    (word) => !word.startsWith("-"),
  );
  return program === undefined
    ? []
    : [{ program, runtime: forced ? BUN : NODE }];
};

/** Bun flags that take the next word as their value. */
const BUN_VALUE_FLAGS = new Set([
  "--config",
  "--elide-lines",
  "--env-file",
  "--port",
  "--preload",
  "--shell",
  "--tsconfig-override",
  "-c",
  "-r",
]);
/** After these, the first positional word names another package's script. */
const BUN_PACKAGE_FLAGS = new Set(["--cwd", "--filter", "-F", "--workspaces"]);

type LaunchContext = {
  executables: ReadonlySet<string>;
  /** Script names of the package the command runs in. */
  scripts: ReadonlySet<string>;
};

/**
 * `bun [run] <name>` runs the package script `<name>` when one exists, and
 * otherwise the executable, on the runtime its shebang names unless `--bun`
 * precedes it.
 */
const bunLaunch = (
  args: readonly string[],
  { executables, scripts }: LaunchContext,
): Launch[] => {
  let forced = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (BUN_PACKAGE_FLAGS.has(arg.split("=", 1)[0] ?? "")) {
      return [];
    }
    if (BUN_RUNTIME_FLAGS.has(arg)) {
      forced = true;
    } else if (BUN_VALUE_FLAGS.has(arg)) {
      index += 1;
    } else if (arg === "x" && index === 0) {
      return bunxLaunch(args.slice(1));
    } else if (arg !== "run" && !arg.startsWith("-")) {
      return executables.has(arg) && !scripts.has(arg)
        ? [{ program: arg, runtime: forced ? BUN : NODE }]
        : [];
    }
  }
  return [];
};

/** The JavaScript programs a shell command starts, and their runtime. */
export const launches = (command: string, context: LaunchContext): Launch[] =>
  lexShell(command).flatMap((event): Launch[] => {
    if (event.type === "unparsed") {
      return panic(`cannot parse ${JSON.stringify(command)}: ${event.reason}`);
    }
    if (event.type !== "command") {
      return [];
    }
    const [program, ...args] = programWords(event.words);
    if (program === undefined) {
      return [];
    }
    if (NODE_PROGRAMS.has(program)) {
      return [{ program, runtime: NODE }];
    }
    if (program === "bunx") {
      return bunxLaunch(args);
    }
    if (program === BUN) {
      return bunLaunch(args, context);
    }
    return context.executables.has(program) ? [{ program, runtime: NODE }] : [];
  });

export type Finding = {
  file: string;
  line: number;
  script: string;
  program: string;
};

const scriptLine = (source: string, name: string): number => {
  const scripts = source.indexOf('"scripts"');
  const index = source.indexOf(`${JSON.stringify(name)}:`, scripts);
  return index === -1
    ? panic(`script ${name} not found in package.json source`)
    : source.slice(0, index).split("\n").length;
};

type ScanResult = { findings: Finding[]; unusedExceptions: string[] };

/** Every package script command that starts a program on Node. */
export const scanPackageScripts = (
  root: string,
  exceptions: Readonly<Record<string, string>> = NODE_RUNTIME_EXCEPTIONS,
): ScanResult => {
  const executables = packageExecutables(root);
  const findings: Finding[] = [];
  const usedExceptions = new Set<string>();
  for (const directory of [".", ...workspaceDirectories(root)]) {
    const file = path.join(directory, "package.json");
    const source = readFileSync(path.join(root, file), "utf-8");
    const scripts = readManifest(path.join(root, file))["scripts"];
    if (!isRecord(scripts)) {
      continue;
    }
    const context = { executables, scripts: new Set(Object.keys(scripts)) };
    for (const [script, command] of Object.entries(scripts)) {
      if (typeof command !== "string") {
        continue;
      }
      for (const { program, runtime } of launches(command, context)) {
        if (runtime === BUN) {
          continue;
        }
        if (Object.hasOwn(exceptions, program)) {
          usedExceptions.add(program);
          continue;
        }
        findings.push({
          file,
          line: scriptLine(source, script),
          script,
          program,
        });
      }
    }
  }
  return {
    findings,
    unusedExceptions: Object.keys(exceptions).filter(
      (program) => !usedExceptions.has(program),
    ),
  };
};

/** The runtime of the last `CMD` in exec form, as the image starts it. */
export const dockerCmdRuntime = (dockerfile: string): string => {
  const command = dockerfile
    .split("\n")
    .findLast((line) => line.startsWith("CMD "))
    ?.slice("CMD ".length)
    .trim();
  const parsed: unknown = command?.startsWith("[")
    ? JSON.parse(command)
    : undefined;
  return Array.isArray(parsed) && typeof parsed[0] === "string"
    ? parsed[0]
    : panic("Dockerfile has no exec-form CMD");
};

if (import.meta.main) {
  const { findings, unusedExceptions } = scanPackageScripts(ROOT);
  const enforced = findings.filter(({ file, line }) =>
    guardEnforcesLine({ guard: GUARD, file, line }),
  );
  for (const { file, line, script, program } of enforced) {
    console.error(
      `${file}:${line}: scripts.${script} starts ${program} on Node; run it as \`bun --bun ${program}\``,
    );
  }
  for (const program of unusedExceptions) {
    console.error(
      `scripts/check-bun-runtime.ts: no package script starts ${program} on Node; remove its exception`,
    );
  }
  process.exitCode = enforced.length + unusedExceptions.length > 0 ? 1 : 0;
}
