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

const SCRIPT = "script";

/**
 * What a command runs for a program name: the executable on Bun or on Node,
 * or, for `bun --bun <name>`, a package script of that name, which Bun
 * prefers over the executable.
 */
export type Runner = typeof BUN | typeof NODE | typeof SCRIPT;

export type Launch = {
  /** The executable or program the command names. */
  program: string;
  runs: Runner;
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

/** bunx options that take the next word as their value. */
const BUNX_VALUE_FLAGS = new Set(["--package", "-p"]);

/**
 * What runs the executable `bunx` or `bun x` starts: Bun only when `--bun`
 * appears among the options before it.
 */
const bunxLaunch = (words: readonly string[]): Launch[] => {
  let forced = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (BUN_RUNTIME_FLAGS.has(word)) {
      forced = true;
    } else if (BUNX_VALUE_FLAGS.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      return [{ program: word, runs: forced ? BUN : NODE }];
    }
  }
  return [];
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
/** After these, the first positional word names other packages' scripts. */
const BUN_WORKSPACE_FLAGS = new Set(["--filter", "-F", "--workspaces"]);
const CWD_FLAG = "--cwd";

type LaunchContext = {
  executables: ReadonlySet<string>;
  /** Script names of the package in a directory relative to the root. */
  scriptsIn: (directory: string) => ReadonlySet<string>;
  /** The directory the command starts in, relative to the root. */
  directory: string;
};

/** A literal directory, or undefined when the shell computes it. */
const literalDirectory = (from: string, to: string | undefined) =>
  to === undefined || to.includes("$") ? undefined : path.join(from, to);

/**
 * `bun [run] <name>` runs the package script `<name>` when the package in
 * the working directory has one, and otherwise the executable, on the
 * runtime its shebang names unless `--bun` precedes it. `bun --bun <name>`
 * where a script shadows the executable runs that script instead, which
 * recurses when it is the script itself.
 */
const bunLaunch = (
  args: readonly string[],
  { executables, scriptsIn, directory }: LaunchContext,
): Launch[] => {
  let forced = false;
  let cwd: string | undefined = directory;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [flag = "", inline] = arg.split(/[=](.*)/su);
    if (BUN_WORKSPACE_FLAGS.has(flag)) {
      return [];
    }
    if (flag === CWD_FLAG) {
      const target = inline ?? args[(index += 1)];
      cwd = cwd === undefined ? undefined : literalDirectory(cwd, target);
    } else if (BUN_RUNTIME_FLAGS.has(arg)) {
      forced = true;
    } else if (BUN_VALUE_FLAGS.has(arg)) {
      index += 1;
    } else if (arg === "x" && index === 0) {
      return bunxLaunch(args.slice(1));
    } else if (arg !== "run" && !arg.startsWith("-")) {
      // A computed directory names an unknown package; nothing to classify.
      if (!executables.has(arg) || cwd === undefined) {
        return [];
      }
      if (scriptsIn(cwd).has(arg)) {
        return forced ? [{ program: arg, runs: SCRIPT }] : [];
      }
      return [{ program: arg, runs: forced ? BUN : NODE }];
    }
  }
  return [];
};

/** The JavaScript programs a shell command starts, and their runtime. */
export const launches = (command: string, context: LaunchContext): Launch[] => {
  const found: Launch[] = [];
  const directories: (string | undefined)[] = [];
  let directory: string | undefined = context.directory;
  for (const event of lexShell(command)) {
    switch (event.type) {
      case "unparsed":
        return panic(
          `cannot parse ${JSON.stringify(command)}: ${event.reason}`,
        );
      case "subshell-start":
        directories.push(directory);
        break;
      case "subshell-end":
        directory = directories.pop();
        break;
      case "control-flow":
        break;
      case "command": {
        const [program, ...args] = programWords(event.words);
        if (program === undefined) {
          break;
        }
        if (program === "cd") {
          directory =
            directory === undefined
              ? undefined
              : literalDirectory(directory, args.at(0));
        } else if (NODE_PROGRAMS.has(program)) {
          found.push({ program, runs: NODE });
        } else if (program === "bunx") {
          found.push(...bunxLaunch(args));
        } else if (program === BUN && directory !== undefined) {
          found.push(...bunLaunch(args, { ...context, directory }));
        } else if (context.executables.has(program)) {
          found.push({ program, runs: NODE });
        }
        break;
      }
      default:
        event satisfies never;
        return panic("unknown shell event");
    }
  }
  return found;
};

export type Finding = {
  file: string;
  line: number;
  script: string;
} & Launch;

const scriptLine = (source: string, name: string): number => {
  const scripts = source.indexOf('"scripts"');
  const index = source.indexOf(`${JSON.stringify(name)}:`, scripts);
  return index === -1
    ? panic(`script ${name} not found in package.json source`)
    : source.slice(0, index).split("\n").length;
};

/** Script names by package directory, read once each. */
const packageScripts = (root: string) => {
  const cache = new Map<string, ReadonlySet<string>>();
  return (directory: string): ReadonlySet<string> => {
    const cached = cache.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    const file = path.join(root, directory, "package.json");
    const scripts = existsSync(file) ? readManifest(file)["scripts"] : {};
    const names = new Set(isRecord(scripts) ? Object.keys(scripts) : []);
    cache.set(directory, names);
    return names;
  };
};

type ScanResult = { findings: Finding[]; unusedExceptions: string[] };

/** Every package script command that starts a program on Node. */
export const scanPackageScripts = (
  root: string,
  exceptions: Readonly<Record<string, string>> = NODE_RUNTIME_EXCEPTIONS,
): ScanResult => {
  const executables = packageExecutables(root);
  const scriptsIn = packageScripts(root);
  const findings: Finding[] = [];
  const usedExceptions = new Set<string>();
  for (const directory of [".", ...workspaceDirectories(root)]) {
    const file = path.join(directory, "package.json");
    const source = readFileSync(path.join(root, file), "utf-8");
    const scripts = readManifest(path.join(root, file))["scripts"];
    if (!isRecord(scripts)) {
      continue;
    }
    const context = { executables, scriptsIn, directory };
    for (const [script, command] of Object.entries(scripts)) {
      if (typeof command !== "string") {
        continue;
      }
      for (const { program, runs } of launches(command, context)) {
        if (runs === BUN) {
          continue;
        }
        if (runs === NODE && Object.hasOwn(exceptions, program)) {
          usedExceptions.add(program);
          continue;
        }
        findings.push({
          file,
          line: scriptLine(source, script),
          script,
          program,
          runs,
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
  for (const { file, line, script, program, runs } of enforced) {
    switch (runs) {
      case NODE:
        console.error(
          `${file}:${line}: scripts.${script} starts ${program} on Node; run it as \`bun --bun ${program}\``,
        );
        break;
      case SCRIPT:
        console.error(
          `${file}:${line}: scripts.${script} runs the package script ${program}, not the executable; run it as \`bunx --bun ${program}\``,
        );
        break;
      case BUN:
        break;
      default:
        runs satisfies never;
        panic(`unknown runner ${String(runs)}`);
    }
  }
  for (const program of unusedExceptions) {
    console.error(
      `scripts/check-bun-runtime.ts: no package script starts ${program} on Node; remove its exception`,
    );
  }
  process.exitCode = enforced.length + unusedExceptions.length > 0 ? 1 : 0;
}
