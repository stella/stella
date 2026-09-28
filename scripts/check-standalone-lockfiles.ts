/**
 * Guard every lockfile the repository tracks besides the root `bun.lock`.
 *
 * The root `bunfig.toml` holds the 5-day release-age quarantine, but Bun reads
 * only the `bunfig.toml` of the directory it installs in. A directory outside
 * the root workspaces with its own `package.json` and `bun.lock` therefore
 * installs, adds and updates with no quarantine at all, however it is invoked
 * (`bun install --cwd <dir>`, or `bun add` inside it). An npm, Yarn or pnpm
 * lockfile never consults a bunfig, so it bypasses the quarantine entirely.
 *
 * Each standalone Bun lockfile must carry every row of `SAFETY_NETS`; any other
 * package manager's lockfile fails outright. `ALLOWLIST` exempts a lockfile
 * that must stay as it is, with the reason why.
 *
 * Needs no dependency install: node builtins and Bun APIs only.
 *
 * Run: `bun scripts/check-standalone-lockfiles.ts`
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  readInstallPolicy,
  type InstallPolicy,
} from "./check-stll-quarantine-excludes";

const SCRIPT_PATH = "scripts/check-standalone-lockfiles.ts";
const ROOT_LOCKFILE = "bun.lock";
const BUNFIG = "bunfig.toml";
const DEPENDABOT = ".github/dependabot.yml";
const TEXT_BUN_LOCKFILE = "bun.lock";
/** Binary: its packages cannot be read, so the excludes net cannot be checked. */
const BINARY_BUN_LOCKFILE = "bun.lockb";
const FOREIGN_LOCKFILES = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const SECONDS_PER_DAY = 86_400;

export type AllowlistEntry = {
  readonly path: string;
  readonly reason: string;
};

/** Lockfiles exempt from this guard. Every entry says why. */
export const ALLOWLIST: readonly AllowlistEntry[] = [];

type RootPolicy = {
  readonly excludes: ReadonlySet<string>;
  readonly minimumReleaseAge: number;
};

type InstallCommand = {
  readonly dir: string;
  readonly frozen: boolean;
  readonly source: string;
};

type DependabotBunUpdate = {
  readonly cooldownDays: number | undefined;
  readonly directories: readonly string[];
};

export type LockfileContext = {
  /** Repo-relative directory holding the lockfile, without a trailing slash. */
  readonly dir: string;
  readonly root: RootPolicy;
  readonly bunfig: InstallPolicy | undefined;
  readonly dependabot: readonly DependabotBunUpdate[];
  readonly installs: readonly InstallCommand[];
  readonly lockedPackages: ReadonlySet<string>;
};

export type SafetyNet = {
  readonly name: string;
  /** What to change so the net holds. */
  readonly fix: (context: LockfileContext) => string;
  /** The reason the net is missing, or undefined when it holds. */
  readonly problem: (context: LockfileContext) => string | undefined;
};

const days = (seconds: number) => Math.ceil(seconds / SECONDS_PER_DAY);

/** The safety nets every standalone Bun lockfile needs. A new net is a row. */
export const SAFETY_NETS: readonly SafetyNet[] = [
  {
    fix: ({ dir, root }) =>
      `add ${dir}/${BUNFIG} with [install] minimumReleaseAge = ${root.minimumReleaseAge}`,
    name: "release-age quarantine",
    problem: ({ bunfig, dir, root }) => {
      if (bunfig === undefined) {
        return `${dir}/${BUNFIG} does not exist, and Bun does not read the root one here`;
      }
      if (bunfig.minimumReleaseAge === undefined) {
        return `${dir}/${BUNFIG} sets no minimumReleaseAge`;
      }
      if (bunfig.minimumReleaseAge < root.minimumReleaseAge) {
        return `${dir}/${BUNFIG} minimumReleaseAge ${bunfig.minimumReleaseAge} is below the root's ${root.minimumReleaseAge}`;
      }
      return undefined;
    },
  },
  {
    fix: ({ dir }) =>
      `make ${dir}/${BUNFIG} minimumReleaseAgeExcludes list exactly the root excludes this lockfile resolves`,
    name: "quarantine excludes",
    problem: ({ bunfig, lockedPackages, root }) => {
      if (bunfig === undefined) {
        return undefined;
      }
      const extra = [...bunfig.excludes].filter(
        (name) => !root.excludes.has(name),
      );
      if (extra.length > 0) {
        return `excludes packages the root does not: ${extra.toSorted().join(", ")}`;
      }
      // A partial exclusion of a native package installs the parent and
      // silently skips its quarantined platform bindings.
      const missing = [...root.excludes].filter(
        (name) => lockedPackages.has(name) && !bunfig.excludes.has(name),
      );
      if (missing.length > 0) {
        return `resolves root-excluded packages without excluding them: ${missing.toSorted().join(", ")}`;
      }
      return undefined;
    },
  },
  {
    fix: ({ dir, root }) =>
      `list "/${dir}" under the bun ecosystem in ${DEPENDABOT} with cooldown default-days >= ${days(root.minimumReleaseAge)}`,
    name: "Dependabot cooldown",
    problem: ({ dependabot, dir, root }) => {
      const covering = dependabot.filter((update) =>
        update.directories.includes(dir),
      );
      if (covering.length === 0) {
        return `no bun update in ${DEPENDABOT} covers /${dir}`;
      }
      const required = days(root.minimumReleaseAge);
      const short = covering.filter(
        (update) => (update.cooldownDays ?? 0) < required,
      );
      if (short.length > 0) {
        return `the ${DEPENDABOT} entry covering /${dir} has a cooldown below ${required} days`;
      }
      return undefined;
    },
  },
  {
    fix: ({ dir }) =>
      `install it with \`bun install --cwd ${dir} --frozen-lockfile\` (a root package.json script, workflow step or shell script) and make every install of it frozen`,
    name: "frozen install",
    problem: ({ dir, installs }) => {
      const targeting = installs.filter((install) => install.dir === dir);
      if (targeting.length === 0) {
        return "no script or workflow installs this directory";
      }
      const unfrozen = targeting.filter((install) => !install.frozen);
      if (unfrozen.length > 0) {
        return `installed without --frozen-lockfile in ${unfrozen.map((install) => install.source).join(", ")}`;
      }
      return undefined;
    },
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeQuotes = (value: string): string =>
  value.replaceAll(/^["']|["']$/gu, "");

/** Repo-relative, no leading `./` or `/`, no trailing `/`; the root is "". */
const normalizeDir = (value: string): string => {
  const normalized = path.posix.normalize(normalizeQuotes(value) || ".");
  const relative = normalized.startsWith("/")
    ? normalized.slice(1)
    : normalized;
  const trimmed = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  return trimmed === "." ? "" : trimmed;
};

const readDependabot = (source: string): DependabotBunUpdate[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !Array.isArray(parsed["updates"])) {
    return [];
  }
  return parsed["updates"].flatMap((update: unknown) => {
    if (!isRecord(update) || update["package-ecosystem"] !== "bun") {
      return [];
    }
    const listed = [
      ...(typeof update["directory"] === "string" ? [update["directory"]] : []),
      ...(Array.isArray(update["directories"])
        ? update["directories"].filter((dir) => typeof dir === "string")
        : []),
    ];
    const cooldown = update["cooldown"];
    const cooldownDays = isRecord(cooldown)
      ? cooldown["default-days"]
      : undefined;
    return [
      {
        cooldownDays:
          typeof cooldownDays === "number" ? cooldownDays : undefined,
        directories: listed.map(normalizeDir),
      },
    ];
  });
};

const INSTALL_SUBCOMMANDS = new Set(["ci", "i", "install"]);

const resolveDir = (base: string, relative: string): string =>
  normalizeDir(
    path.posix.join(base === "" ? "." : base, normalizeQuotes(relative)),
  );

/**
 * Finds `bun install`/`bun i`/`bun ci` in one line of shell. The target is the
 * `--cwd` value, else the directory of a `cd` earlier on the line, else
 * `baseDir` (a workflow step's working directory, or the repository root).
 * Grouping such as `(cd dir && bun install)` is read through, not skipped.
 */
export const parseInstallCommands = (
  line: string,
  source: string,
  baseDir = "",
): InstallCommand[] => {
  const commands: InstallCommand[] = [];
  let cdDir = baseDir;
  for (const segment of line.split(/&&|\|\||[;|]/u)) {
    const tokens = segment
      .replaceAll(/\$\(|[(){}`]/gu, " ")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (tokens[0] === "cd" && tokens[1] !== undefined) {
      cdDir = resolveDir(cdDir, tokens[1]);
      continue;
    }
    const bunIndex = tokens.findIndex(
      (token) => token === "bun" || token.endsWith("/bun"),
    );
    if (bunIndex === -1) {
      continue;
    }
    let cwd: string | undefined;
    let subcommand: string | undefined;
    const rest = tokens.slice(bunIndex + 1);
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index] ?? "";
      if (token === "--cwd") {
        cwd = rest[index + 1];
        index++;
      } else if (token.startsWith("--cwd=")) {
        cwd = token.slice("--cwd=".length);
      } else if (subcommand === undefined && !token.startsWith("-")) {
        subcommand = token;
      }
    }
    if (subcommand === undefined || !INSTALL_SUBCOMMANDS.has(subcommand)) {
      continue;
    }
    commands.push({
      dir: cwd === undefined ? cdDir : resolveDir(cdDir, cwd),
      frozen:
        subcommand === "ci" ||
        rest.some(
          (token) =>
            token === "--frozen-lockfile" || token === "--frozen-lockfile=true",
        ),
      source,
    });
  }
  return commands;
};

const isInstallSource = (file: string): boolean =>
  file === "package.json" ||
  file === "lefthook.yml" ||
  file.endsWith(".sh") ||
  (file.startsWith(".github/") && /\.ya?ml$/u.test(file));

type RunBlock = {
  readonly baseDir: string;
  readonly run: string;
  readonly source: string;
};

const workingDirectory = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const run = value["run"];
  if (!isRecord(run)) {
    return undefined;
  }
  const dir = run["working-directory"];
  return typeof dir === "string" ? dir : undefined;
};

const stepRunBlocks = (
  steps: unknown,
  baseDir: string,
  source: string,
): RunBlock[] =>
  Array.isArray(steps)
    ? steps.flatMap((step: unknown, index) => {
        if (!isRecord(step) || typeof step["run"] !== "string") {
          return [];
        }
        const dir = step["working-directory"];
        const name =
          typeof step["name"] === "string" ? step["name"] : `#${index + 1}`;
        return [
          {
            baseDir: typeof dir === "string" ? resolveDir("", dir) : baseDir,
            run: step["run"],
            source: `${source} step "${name}"`,
          },
        ];
      })
    : [];

/**
 * The `run` scripts of a workflow or composite action, each with the working
 * directory its step, job or workflow defaults set.
 */
const workflowRunBlocks = (
  text: string,
  file: string,
): RunBlock[] | undefined => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const workflowDir = resolveDir(
    "",
    workingDirectory(parsed["defaults"]) ?? "",
  );
  const blocks: RunBlock[] = [];
  const jobs = parsed["jobs"];
  if (isRecord(jobs)) {
    for (const [jobName, job] of Object.entries(jobs)) {
      if (!isRecord(job)) {
        continue;
      }
      const jobDir = workingDirectory(job["defaults"]);
      blocks.push(
        ...stepRunBlocks(
          job["steps"],
          jobDir === undefined ? workflowDir : resolveDir("", jobDir),
          `${file} job "${jobName}"`,
        ),
      );
    }
  }
  const runs = parsed["runs"];
  if (isRecord(runs)) {
    blocks.push(...stepRunBlocks(runs["steps"], "", file));
  }
  return blocks;
};

const shellLines = (
  text: string,
  source: (line: number) => string,
  baseDir: string,
) =>
  text
    .split("\n")
    .flatMap((line, index) =>
      line.trimStart().startsWith("#")
        ? []
        : parseInstallCommands(line, source(index + 1), baseDir),
    );

const readInstallCommands = (
  root: string,
  trackedFiles: readonly string[],
): InstallCommand[] =>
  trackedFiles.filter(isInstallSource).flatMap((file) => {
    const text = readFileSync(path.join(root, file), "utf-8");
    if (file === "package.json") {
      const parsed: unknown = JSON.parse(text);
      const scripts = isRecord(parsed) ? parsed["scripts"] : undefined;
      return isRecord(scripts)
        ? Object.entries(scripts).flatMap(([name, script]) =>
            typeof script === "string"
              ? parseInstallCommands(script, `package.json "${name}"`)
              : [],
          )
        : [];
    }
    const blocks = file.startsWith(".github/")
      ? workflowRunBlocks(text, file)
      : undefined;
    if (blocks === undefined) {
      return shellLines(text, (line) => `${file}:${line}`, "");
    }
    return blocks.flatMap((block) =>
      shellLines(block.run, () => block.source, block.baseDir),
    );
  });

/** Package names a text `bun.lock` resolves. */
const readLockedPackages = (lockfile: string): Set<string> =>
  new Set(
    [...lockfile.matchAll(/\["((?:@[^/"]+\/)?[^@"]+)@[^"]*"/gu)].map(
      (match) => match[1] ?? "",
    ),
  );

const excludedByAllowlist = (
  file: string,
  allowlist: readonly AllowlistEntry[],
) => allowlist.some((entry) => entry.path === file);

export type CheckResult = {
  readonly covered: readonly string[];
  readonly errors: readonly string[];
};

export const checkStandaloneLockfiles = ({
  allowlist = ALLOWLIST,
  root,
  trackedFiles,
}: {
  allowlist?: readonly AllowlistEntry[];
  root: string;
  trackedFiles: readonly string[];
}): CheckResult => {
  const files = trackedFiles.filter(
    (file) => !file.split("/").includes("node_modules"),
  );
  const tracked = new Set(files);
  const errors: string[] = [];
  const allowHint = `or, if it must stay as it is, add it to ALLOWLIST in ${SCRIPT_PATH} with the reason`;

  for (const entry of allowlist) {
    if (!tracked.has(entry.path)) {
      errors.push(
        `${SCRIPT_PATH} ALLOWLIST names ${entry.path}, which is not a tracked file. Remove the entry.`,
      );
    }
  }

  const rootPolicy = readInstallPolicy(
    readFileSync(path.join(root, BUNFIG), "utf-8"),
  );
  if (rootPolicy.minimumReleaseAge === undefined) {
    errors.push(
      `${BUNFIG} sets no minimumReleaseAge; this guard compares every standalone lockfile against it.`,
    );
    return { covered: [], errors };
  }
  const rootWithAge: RootPolicy = {
    excludes: rootPolicy.excludes,
    minimumReleaseAge: rootPolicy.minimumReleaseAge,
  };

  const dependabotPath = path.join(root, DEPENDABOT);
  const dependabot = existsSync(dependabotPath)
    ? readDependabot(readFileSync(dependabotPath, "utf-8"))
    : [];
  const installs = readInstallCommands(root, files);
  const covered: string[] = [];

  for (const file of files) {
    const base = path.posix.basename(file);
    const dir =
      path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (file === ROOT_LOCKFILE || excludedByAllowlist(file, allowlist)) {
      continue;
    }

    if (base === BINARY_BUN_LOCKFILE) {
      errors.push(
        `${file}: a binary Bun lockfile cannot be checked against the quarantine ` +
          `excludes. Convert it to a text ${TEXT_BUN_LOCKFILE} (\`bun install --save-text-lockfile\`) ` +
          `and delete it, ${allowHint}.`,
      );
      continue;
    }
    if (
      FOREIGN_LOCKFILES.has(base) ||
      (base === TEXT_BUN_LOCKFILE && dir === "")
    ) {
      errors.push(
        `${file}: this lockfile bypasses the repository's release-age quarantine ` +
          `(only Bun reads bunfig.toml, and the root resolves from ${ROOT_LOCKFILE}). ` +
          `Delete it and install with Bun, ${allowHint}.`,
      );
      continue;
    }
    if (base !== TEXT_BUN_LOCKFILE) {
      continue;
    }

    const bunfigFile = `${dir}/${BUNFIG}`;
    const context: LockfileContext = {
      bunfig: tracked.has(bunfigFile)
        ? readInstallPolicy(readFileSync(path.join(root, bunfigFile), "utf-8"))
        : undefined,
      dependabot,
      dir,
      installs,
      lockedPackages: readLockedPackages(
        readFileSync(path.join(root, file), "utf-8"),
      ),
      root: rootWithAge,
    };
    const missing = SAFETY_NETS.flatMap((net) => {
      const problem = net.problem(context);
      return problem === undefined
        ? []
        : [`  - ${net.name}: ${problem}.\n    Fix: ${net.fix(context)}.`];
    });
    if (missing.length === 0) {
      covered.push(file);
      continue;
    }
    errors.push(
      `${file} is a standalone Bun lockfile missing ${missing.length} safety net(s):\n` +
        `${missing.join("\n")}\n` +
        `Add them, ${allowHint}.`,
    );
  }

  return { covered, errors };
};

const main = () => {
  const root = path.resolve(import.meta.dir, "..");
  // Runs before any dependency install, so it reports and exits instead of
  // throwing through better-result.
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listed.exitCode !== 0) {
    console.error(`git ls-files failed: ${listed.stderr.toString()}`);
    process.exit(1);
  }
  const result = checkStandaloneLockfiles({
    root,
    trackedFiles: listed.stdout.toString().split("\0").filter(Boolean),
  });
  if (result.errors.length > 0) {
    console.error(result.errors.join("\n\n"));
    process.exit(1);
  }
  const list =
    result.covered.length > 0 ? ` (${result.covered.join(", ")})` : "";
  console.log(
    `Standalone lockfiles: ${result.covered.length} covered by all ${SAFETY_NETS.length} safety nets${list}.`,
  );
};

if (import.meta.main) {
  main();
}
