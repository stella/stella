// Every network fetch in CI either retries or is served by a cache-first
// action, and every step that fetches has its own deadline.
//
// Rules, checked over every workflow and repository composite action:
// - retry: a `run:` command that fetches (curl, wget, cargo fetch/install,
//   any other cargo command that resolves the dependency graph, bun
//   install/ci/add, npm/pnpm/yarn install, npx/bunx of a remote package,
//   docker pull, playwright install, gh release download, git clone) runs
//   through scripts/retry.sh, or scripts/gh-retry.sh for the GitHub API. A
//   curl that carries its own `--retry N --retry-all-errors` budget counts as
//   retried, and a curl or wget that only names a loopback address is a
//   readiness probe, not a fetch. A cargo command that runs `--frozen` or
//   `--offline`, or under `CARGO_NET_OFFLINE=true` (inline, or in the step,
//   job or workflow env), downloads nothing: its crates come from a retried
//   `cargo fetch --locked` before it. Repository shell scripts a step invokes
//   are scanned too; a script invoked through retry.sh is retried as a whole.
// - timeout: a workflow step that fetches, in its own `run:`, in a script it
//   invokes, or through a repository composite action, declares its own
//   `timeout-minutes`. The job deadline does not count: it bounds the whole
//   job, so a hung download would spend every other step's budget first.
//   Composite steps cannot declare a timeout, so the calling step owns it.
//
// Actions such as actions/cache, actions/setup-*, oven-sh/setup-bun and
// docker/login-action are cache-first or retry internally and are not
// commands this guard parses. scripts/ci-network-steps-allowlist.json lists
// the steps that cannot comply yet, one reason each. It only shrinks: an
// entry that no longer matches a violation fails, and `--base <ref>` rejects
// entries the base revision does not have.
import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { BASELINE_PATHS } from "./baseline-paths";
import { addedEntries } from "./ledger-membership";
import { flattenWorkflowSteps } from "./workflow-steps";

const ALLOWLIST_REL = BASELINE_PATHS.ciNetworkSteps;

export type NetworkRule = "retry" | "timeout";

/** What the environment of a scanned command already guarantees. */
export type ShellContext = {
  /** CARGO_NET_OFFLINE=true: cargo resolves from its local cache only. */
  cargoOffline?: boolean;
};

export type NetworkFetch = {
  kind: string;
  wrapped: boolean;
  command: string;
  source: string;
};

export type NetworkViolation = {
  id: string;
  rule: NetworkRule;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FETCH_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "curl", pattern: /(?:^|[\s"'(`=])curl(?=\s|$)/u },
  { kind: "wget", pattern: /(?:^|[\s"'(`=])wget(?=\s|$)/u },
  {
    kind: "cargo fetch/install",
    pattern: /\bcargo\s+(?:\+\S+\s+)?(?:fetch|install|binstall)(?=\s|$)/u,
  },
  {
    kind: "bun install",
    pattern: /\bbun\s+(?:--\S+\s+)*(?:install|i|ci|add)(?=\s|$)/u,
  },
  {
    kind: "package manager install",
    pattern:
      /\b(?:npm\s+(?:install|i|ci|add)|pnpm\s+(?:install|i|add)|yarn\s+(?:install|add))(?=\s|$)/u,
  },
  { kind: "docker pull", pattern: /\bdocker\s+(?:image\s+)?pull(?=\s|$)/u },
  { kind: "playwright install", pattern: /\bplaywright\s+install(?=\s|$)/u },
  {
    kind: "gh release download",
    pattern:
      /(?:\bgh|gh-retry\.sh["']?|\$\{?GH_RETRY_SCRIPT\}?["']?)\s+release\s+download(?=\s|$)/u,
  },
  { kind: "git clone", pattern: /\bgit\s+(?:-c\s+\S+\s+)*clone(?=\s|$)/u },
];

// Cargo downloads every crate missing from its cache whenever a command reads
// the dependency graph, so building, testing and linting fetch just as
// `cargo fetch` does. The Tauri CLI drives the same cargo build.
const CARGO_RESOLVE =
  /\bcargo\s+(?:\+\S+\s+)?(?:build|b|check|c|test|t|clippy|doc|d|run|r|bench|rustc|rustdoc|tree|metadata|deny|nextest|llvm-cov|update|generate-lockfile|vendor|package|publish|tauri)(?=\s|$)|\btauri\s+(?:build|dev|bundle)(?=\s|$)/u;
const CARGO_OFFLINE_FLAG = /(?:^|\s)--(?:frozen|offline)(?=[\s=]|$)/u;
const CARGO_OFFLINE_ASSIGNMENT = /\bCARGO_NET_OFFLINE=["']?true["']?(?=\s)/u;
const CARGO_NO_DEPS = /(?:^|\s)--no-deps(?=\s|$)/u;

/** Whether a cargo command that reads the dependency graph may download. */
const cargoResolveFetches = (
  segment: string,
  context: ShellContext,
): boolean => {
  const match = CARGO_RESOLVE.exec(segment);
  if (match === null || context.cargoOffline === true) {
    return false;
  }
  // Arguments after `--` belong to the program cargo runs, not to cargo.
  const own = segment.slice(match.index).split(/\s--(?=\s|$)/u)[0] ?? "";
  const metadataOnly = /^cargo\s+(?:\+\S+\s+)?metadata\b/u.test(own);
  return !(
    CARGO_OFFLINE_FLAG.test(own) ||
    CARGO_OFFLINE_ASSIGNMENT.test(segment.slice(0, match.index)) ||
    // Package metadata without the dependency graph reads only manifests.
    (metadataOnly && CARGO_NO_DEPS.test(own))
  );
};

// Shell syntax that may precede a command without changing what it runs.
const CONTROL_PREFIX =
  /^(?:(?:if|while|until|time|!|\{|\(|\$\(|`|exec|command|env|[A-Za-z_]\w*=(?:\$\(|`|"[^"]*"|'[^']*'|[^\s$`(]*))(?:\s+|(?<=[(`])))+/u;
// A command retries only when the retry helper is the command it runs.
const RETRY_START =
  /^(?:(?:bash|sh)\s+)?(?:["']?[^\s"']*(?:gh-)?retry\.sh["']?|"?\$\{?\w*(?:retry|RETRY)\w*\}?"?)(?:\s|$)/u;

/** Whether a command segment runs through the retry helper. */
const startsWithRetry = (segment: string): boolean =>
  RETRY_START.test(segment.replace(CONTROL_PREFIX, ""));
const NATIVE_CURL_RETRY = /--retry[\s=]+[1-9]/u;
// A loopback host ends the hostname: `localhost.example.com` is remote.
const LOOPBACK = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?![\w.-])|\[::1\]/u;
const REMOTE_URL =
  /\bhttps?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?![\w.-])|\[::1\])/u;
const PROSE = /^\s*(?:echo|printf|:)(?:\s|$)/u;

// A `case` arm's pattern list (`a|b|scripts/x.sh)`) names paths, not commands.
const CASE_PATTERN = /^\s*[^\s"'`$()=|]+(?:\|[^\s"'`$()=|]+)*\)/u;

/** The end of a `$(...)` body starting at `start`, honoring nesting and quotes. */
const substitutionEnd = (line: string, start: number): number => {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
    } else if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return line.length;
};

/**
 * Lift command substitutions out of a line. The shell runs them before the
 * enclosing command starts, so an enclosing retry.sh never retries them: each
 * body becomes its own command line and the enclosing line keeps a
 * placeholder.
 */
export const liftSubstitutions = (line: string): string[] => {
  const lifted: string[] = [];
  let outer = "";
  let single = false;
  // Inside double quotes an apostrophe is literal text, not a quote.
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\" && !single) {
      outer += line.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      outer += character;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      outer += character;
      continue;
    }
    if (single) {
      outer += character;
      continue;
    }
    if (
      character === "$" &&
      line[index + 1] === "(" &&
      line[index + 2] !== "("
    ) {
      const end = substitutionEnd(line, index + 2);
      lifted.push(...liftSubstitutions(line.slice(index + 2, end)));
      outer += "SUBSTITUTION";
      index = end;
      continue;
    }
    if (character === "`") {
      const close = line.indexOf("`", index + 1);
      const end = close === -1 ? line.length : close;
      lifted.push(...liftSubstitutions(line.slice(index + 1, end)));
      outer += "SUBSTITUTION";
      index = end;
      continue;
    }
    outer += character;
  }
  return [outer, ...lifted];
};

/** Drop comments and join continuation lines, keeping one logical line each. */
const logicalLines = (source: string): string[] =>
  source
    .replaceAll(/\\\r?\n/gu, " ")
    .split("\n")
    .map((line) => line.replace(CASE_PATTERN, ""))
    .map((line) => {
      let quote: "'" | '"' | null = null;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === "\\" && quote !== "'") {
          index += 1;
        } else if (quote !== null) {
          if (character === quote) {
            quote = null;
          }
        } else if (character === "'" || character === '"') {
          quote = character;
        } else if (
          character === "#" &&
          (index === 0 || /\s/u.test(line[index - 1] ?? ""))
        ) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .flatMap(liftSubstitutions);

/** Split a logical line on command separators outside quotes. */
const segments = (line: string): string[] => {
  const parts: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      parts.push(line.slice(start, index));
      if (line[index + 1] === character) {
        index += 1;
      }
      start = index + 1;
    }
  }
  parts.push(line.slice(start));
  return parts
    .flatMap((part) => part.split(/(?:^|\s)(?:then|do|else|elif)(?=\s|$)/u))
    .map((part) => part.trim())
    .filter((part) => part !== "");
};

const PACKAGE_RUNNER =
  /\b(?:(?<dlx>pnpm\s+dlx|yarn\s+dlx)|npx|bunx|bun\s+x)\s(?<rest>.*)$/u;
const RUNNER_INSTALL_FLAGS = new Set(["--yes", "-y", "--package", "-p"]);

/**
 * Whether a package runner downloads. dlx always installs into a temporary
 * directory; npx and bunx run a local binary when the package is a declared
 * dependency, and download it otherwise, or when a version or an install flag
 * is given. Binary aliases are matched by package name only.
 */
const runnerFetches = (
  segment: string,
  declared: ReadonlySet<string>,
): boolean => {
  const match = PACKAGE_RUNNER.exec(segment);
  if (match === null) {
    return false;
  }
  if (match.groups?.["dlx"] !== undefined) {
    return true;
  }
  for (const token of (match.groups?.["rest"] ?? "").split(/\s+/u)) {
    const flag = token.split("=")[0] ?? token;
    if (RUNNER_INSTALL_FLAGS.has(flag)) {
      return true;
    }
    if (token.startsWith("-") || token === "") {
      continue;
    }
    const name = token.replaceAll(/["']/gu, "");
    // `@scope/name@1` and `name@1` carry a version; `@scope/name` does not.
    if (name.lastIndexOf("@") > 0) {
      return true;
    }
    return !declared.has(name);
  }
  return false;
};

/** The fetches one shell source runs, and whether each one retries. */
export const scanShell = (
  source: string,
  label: string,
  declared: ReadonlySet<string> = new Set(),
  context: ShellContext = {},
): NetworkFetch[] =>
  logicalLines(source).flatMap((line) =>
    segments(line).flatMap((segment): NetworkFetch[] => {
      if (PROSE.test(segment)) {
        return [];
      }
      const wrapped = startsWithRetry(segment);
      const runner: NetworkFetch[] = runnerFetches(segment, declared)
        ? [
            {
              kind: "remote package runner",
              wrapped,
              command: segment,
              source: label,
            },
          ]
        : [];
      const cargo: NetworkFetch[] = cargoResolveFetches(segment, context)
        ? [
            {
              kind: "cargo dependency resolution",
              wrapped,
              command: segment,
              source: label,
            },
          ]
        : [];
      return [
        ...runner,
        ...cargo,
        ...FETCH_PATTERNS.flatMap(({ kind, pattern }) => {
          const match = pattern.exec(segment);
          if (match === null) {
            return [];
          }
          if (
            (kind === "curl" || kind === "wget") &&
            LOOPBACK.test(segment) &&
            !REMOTE_URL.test(segment)
          ) {
            return [];
          }
          return [
            {
              kind,
              wrapped:
                wrapped ||
                (kind === "curl" &&
                  NATIVE_CURL_RETRY.test(segment) &&
                  segment.includes("--retry-all-errors")),
              command: segment,
              source: label,
            },
          ];
        }),
      ];
    }),
  );

type ScriptReference = { file: string; wrapped: boolean };

// Any mention of a repository script counts as running it: over-reporting
// is cheaper than missing an invocation behind `if !`, `$(...)`, `source` or a
// pipeline, and an over-report can be allowlisted with a reason.
const SCRIPT_REFERENCE =
  /(?:(?:\$\{?GITHUB_WORKSPACE\}?|\$\{\{\s*github\.workspace\s*\}\})\/(?<workspace>[\w./-]+\.sh)|(?:\$\{?GITHUB_ACTION_PATH\}?|\$\{\{\s*github\.action_path\s*\}\})\/(?<action>[\w./-]+\.sh)|(?<![\w./-])\.\/(?<dot>[\w./-]+\.sh)|(?<=^|[^\w./-]|\.[\w-]+\/)(?<rooted>(?:scripts|\.github|apps|packages)\/[\w./-]+\.sh))/gu;
const RETRY_SCRIPTS = new Set(["scripts/retry.sh", "scripts/gh-retry.sh"]);

const joined = (dir: string, file: string): string =>
  path.posix.normalize(path.posix.join(dir, file));

/**
 * Repository files a reference may name. The working directory (the
 * repository root unless a `working-directory:` says otherwise) resolves
 * `./x.sh` and bare `scripts/x.sh`; the action directory resolves
 * `$GITHUB_ACTION_PATH/x.sh`; `$GITHUB_WORKSPACE/` is the repository root.
 */
const referencedFiles = (
  groups: Record<string, string | undefined>,
  actionDir: string | null,
  cwd: string,
): string[] => {
  const { workspace, action, dot, rooted } = groups;
  if (workspace !== undefined) {
    return [joined(".", workspace)];
  }
  if (action !== undefined) {
    return actionDir === null ? [] : [joined(actionDir, action)];
  }
  if (dot !== undefined) {
    return [
      joined(cwd, dot),
      ...(actionDir === null ? [] : [joined(actionDir, dot)]),
    ];
  }
  return rooted === undefined ? [] : [joined(cwd, rooted), rooted];
};

const ASSIGNMENT = /^\s*(?:(?:local|readonly|declare)\s+)?([A-Za-z_]\w*)=/u;

/**
 * Variables a script sets to its own directory, as in
 * `here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` or `$(dirname "$0")`.
 */
const scriptDirectoryVariables = (source: string): string[] =>
  // Raw lines: logicalLines() replaces the `$(dirname ...)` body.
  source.split("\n").flatMap((line) => {
    const name = ASSIGNMENT.exec(line)?.[1];
    return name !== undefined &&
      line.includes("dirname") &&
      (line.includes("BASH_SOURCE") || line.includes("$0"))
      ? [name]
      : [];
  });

const isPathCharacter = (character: string): boolean =>
  /[\w./-]/u.test(character);

/** `$here/x.sh` and `${here}/x.sh` for each script-directory variable. */
const scriptDirectoryReferences = (
  segment: string,
  names: readonly string[],
  dir: string,
): string[] =>
  names.flatMap((name) =>
    [`$${name}/`, `\${${name}}/`].flatMap((prefix) => {
      const files: string[] = [];
      for (
        let at = segment.indexOf(prefix);
        at >= 0;
        at = segment.indexOf(prefix, at + 1)
      ) {
        let end = at + prefix.length;
        while (end < segment.length && isPathCharacter(segment[end] ?? "")) {
          end += 1;
        }
        const file = segment.slice(at + prefix.length, end);
        if (file.endsWith(".sh")) {
          files.push(joined(dir, file));
        }
      }
      return files;
    }),
  );

/** Repository shell scripts a source invokes, resolved from the repo root. */
const scriptReferences = (
  source: string,
  actionDir: string | null,
  cwd: string,
): ScriptReference[] => {
  const directoryVariables =
    actionDir === null ? [] : scriptDirectoryVariables(source);
  return logicalLines(source).flatMap((line) =>
    segments(line).flatMap((segment) => {
      const wrapped = startsWithRetry(segment);
      const files = [
        ...[...segment.matchAll(SCRIPT_REFERENCE)].flatMap((match) =>
          referencedFiles(match.groups ?? {}, actionDir, cwd),
        ),
        ...(actionDir === null
          ? []
          : scriptDirectoryReferences(segment, directoryVariables, actionDir)),
      ];
      // Test scripts stub the network commands they exercise.
      return [...new Set(files)]
        .filter(
          (file) => !RETRY_SCRIPTS.has(file) && !file.endsWith(".test.sh"),
        )
        .map((file) => ({ file, wrapped }));
    }),
  );
};

type Repository = {
  read: (file: string) => string | null;
  glob: (pattern: string) => string[];
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** Dependency names declared by the root and every workspace manifest. */
export const declaredDependencies = (repo: Repository): Set<string> => {
  const names = new Set<string>();
  const manifest = (file: string): Record<string, unknown> | null => {
    const text = repo.read(file);
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return record(parsed) ? parsed : null;
  };
  const root = manifest("package.json");
  const workspaces = Array.isArray(root?.["workspaces"])
    ? root["workspaces"].filter((entry) => typeof entry === "string")
    : [];
  const files = [
    "package.json",
    ...workspaces.flatMap((pattern) => repo.glob(`${pattern}/package.json`)),
  ];
  for (const file of files) {
    const parsed = manifest(file);
    for (const field of DEPENDENCY_FIELDS) {
      const deps = parsed?.[field];
      if (record(deps)) {
        for (const name of Object.keys(deps)) {
          names.add(name);
        }
      }
    }
  }
  return names;
};

const MAX_SCRIPT_DEPTH = 4;

/** Fetches in a run step, including the repository scripts it invokes. */
type RunContext = {
  /** Packages a runner resolves locally instead of downloading. */
  declared: ReadonlySet<string>;
  /** Directory of the composite action that owns the step, if any. */
  actionDir: string | null;
  /** File reported as the source of fetches written in the step. */
  label: string;
  /** Working directory relative to the repository root. */
  cwd?: string;
  /** Guarantees of the step environment, inherited by invoked scripts. */
  shell?: ShellContext;
};

export const runFetches = (
  repo: Repository,
  run: string,
  { actionDir, label, cwd = ".", declared, shell = {} }: RunContext,
): NetworkFetch[] => {
  const fetches = scanShell(run, label, declared, shell);
  const visited = new Set<string>();
  const follow = (
    source: string,
    dir: string | null,
    wrapped: boolean,
    depth: number,
  ) => {
    if (depth > MAX_SCRIPT_DEPTH) {
      return;
    }
    for (const reference of scriptReferences(source, dir, cwd)) {
      const inherited = wrapped || reference.wrapped;
      // A script reached once through retry.sh and once bare is scanned in
      // both contexts, so the bare invocation still reports its fetches.
      const visit = `${reference.file}\0${String(inherited)}`;
      if (visited.has(visit)) {
        continue;
      }
      visited.add(visit);
      const script = repo.read(reference.file);
      if (script === null) {
        continue;
      }
      for (const fetch of scanShell(script, reference.file, declared, shell)) {
        fetches.push({ ...fetch, wrapped: fetch.wrapped || inherited });
      }
      follow(script, path.posix.dirname(reference.file), inherited, depth + 1);
    }
  };
  follow(run, actionDir, false, 1);
  return fetches;
};

const LOCAL_ACTION =
  /^(?:\.\/|\$\/)(?:\.[\w-]+\/)?(\.github\/actions\/[\w./-]+?)\/?$/u;

/** The repository action a `uses:` names, or null for a remote action. */
export const localAction = (uses: string): string | null => {
  const match = LOCAL_ACTION.exec(uses);
  return match?.[1] ?? null;
};

const stepName = (step: Record<string, unknown>, index: number): string => {
  for (const key of ["name", "id", "uses"] as const) {
    const value = step[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  const run = step["run"];
  if (typeof run === "string") {
    const first = run.trim().split("\n")[0] ?? "";
    if (first !== "") {
      return first.slice(0, 80);
    }
  }
  return `step ${index + 1}`;
};

/** The innermost of the given `env:` scopes that sets the variable. */
const envValue = (
  scopes: readonly Record<string, unknown>[],
  name: string,
): unknown => {
  for (const scope of scopes) {
    const env = scope["env"];
    if (record(env) && env[name] !== undefined) {
      return env[name];
    }
  }
  return undefined;
};

/** What the step's env, then its job's, then its workflow's guarantee. */
const shellContext = (
  ...scopes: readonly Record<string, unknown>[]
): ShellContext => {
  const offline = envValue(scopes, "CARGO_NET_OFFLINE");
  return { cargoOffline: offline === true || offline === "true" };
};

const defaultWorkingDirectory = (scope: Record<string, unknown>): unknown => {
  const defaults = scope["defaults"];
  const run = record(defaults) ? defaults["run"] : undefined;
  return record(run) ? run["working-directory"] : undefined;
};

/** The step's working directory relative to the repository root. */
const workingDirectory = (
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
  step: Record<string, unknown>,
): string => {
  const configured = [
    step["working-directory"],
    defaultWorkingDirectory(job),
    defaultWorkingDirectory(workflow),
  ].find((value) => typeof value === "string");
  // An expression cannot be resolved statically; the root is the default.
  if (typeof configured !== "string" || configured.includes("${{")) {
    return ".";
  }
  return joined(".", configured);
};

export const violationId = (
  file: string,
  job: string,
  step: string,
  rule: NetworkRule,
): string => `${file}#${job}#${step}#${rule}`;

const hasTimeout = (step: Record<string, unknown>): boolean => {
  const timeout = step["timeout-minutes"];
  return (
    (typeof timeout === "number" && timeout > 0) ||
    (typeof timeout === "string" && timeout.trim() !== "")
  );
};

const describe = (fetches: readonly NetworkFetch[]): string =>
  [...new Set(fetches.map((fetch) => `${fetch.kind} (${fetch.source})`))].join(
    ", ",
  );

type ActionSummary = { fetches: NetworkFetch[] };

/** Violations across the given workflow and composite action sources. */
export const networkViolations = (
  repo: Repository,
  workflows: readonly string[],
  actions: readonly string[],
): NetworkViolation[] => {
  const violations = new Map<string, NetworkViolation>();
  const add = (violation: NetworkViolation) => {
    if (!violations.has(violation.id)) {
      violations.set(violation.id, violation);
    }
  };
  const actionCache = new Map<string, ActionSummary>();
  const declared = declaredDependencies(repo);

  const summarizeAction = (dir: string, stack: Set<string>): ActionSummary => {
    const cached = actionCache.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const summary: ActionSummary = { fetches: [] };
    if (stack.has(dir)) {
      return summary;
    }
    const file = [`${dir}/action.yml`, `${dir}/action.yaml`].find(
      (candidate) => repo.read(candidate) !== null,
    );
    if (file === undefined) {
      return summary;
    }
    stack.add(dir);
    const parsed: unknown = Bun.YAML.parse(repo.read(file) ?? "");
    const runs = record(parsed) && record(parsed["runs"]) ? parsed["runs"] : {};
    const steps = Array.isArray(runs["steps"]) ? runs["steps"] : [];
    for (const [index, rawStep] of steps.entries()) {
      if (!record(rawStep)) {
        continue;
      }
      const name = stepName(rawStep, index);
      const run = rawStep["run"];
      if (typeof run === "string") {
        const fetches = runFetches(repo, run, {
          actionDir: dir,
          label: file,
          // Composite actions have no defaults; only the step can set it.
          cwd: workingDirectory({}, {}, rawStep),
          declared,
          shell: shellContext(rawStep),
        });
        summary.fetches.push(...fetches);
        const unwrapped = fetches.filter((fetch) => !fetch.wrapped);
        if (unwrapped.length > 0) {
          add({
            id: violationId(file, "runs", name, "retry"),
            rule: "retry",
            message: `${file}: ${name}: route ${describe(unwrapped)} through scripts/retry.sh`,
          });
        }
      }
      const uses = rawStep["uses"];
      const nested = typeof uses === "string" ? localAction(uses) : null;
      if (nested !== null) {
        summary.fetches.push(...summarizeAction(nested, stack).fetches);
      }
    }
    stack.delete(dir);
    actionCache.set(dir, summary);
    return summary;
  };

  for (const action of actions) {
    summarizeAction(path.posix.dirname(action), new Set());
  }

  for (const file of workflows) {
    const parsed: unknown = Bun.YAML.parse(repo.read(file) ?? "");
    if (!record(parsed)) {
      return panic(`Expected a YAML mapping in ${file}`);
    }
    const jobs = record(parsed["jobs"]) ? parsed["jobs"] : {};
    for (const [job, rawJob] of Object.entries(jobs)) {
      if (!record(rawJob) || rawJob["steps"] === undefined) {
        continue;
      }
      for (const [index, step] of flattenWorkflowSteps(
        rawJob["steps"],
      ).entries()) {
        const name = stepName(step, index);
        const fetches: NetworkFetch[] = [];
        const run = step["run"];
        if (typeof run === "string") {
          const own = runFetches(repo, run, {
            declared,
            actionDir: null,
            label: file,
            cwd: workingDirectory(parsed, rawJob, step),
            shell: shellContext(step, rawJob, parsed),
          });
          // A download inside an invoked script hangs the step exactly like
          // an inline one, so script fetches count for the timeout rule too.
          fetches.push(...own);
          const unwrapped = own.filter((fetch) => !fetch.wrapped);
          if (unwrapped.length > 0) {
            add({
              id: violationId(file, job, name, "retry"),
              rule: "retry",
              message: `${file}: ${job}: ${name}: route ${describe(unwrapped)} through scripts/retry.sh`,
            });
          }
        }
        const uses = step["uses"];
        const action = typeof uses === "string" ? localAction(uses) : null;
        if (action !== null) {
          fetches.push(...summarizeAction(action, new Set()).fetches);
        }
        if (fetches.length > 0 && !hasTimeout(step)) {
          add({
            id: violationId(file, job, name, "timeout"),
            rule: "timeout",
            message: `${file}: ${job}: ${name}: ${describe(fetches)} needs a step timeout-minutes`,
          });
        }
      }
    }
  }
  return [...violations.values()].toSorted((left, right) => {
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
};

const AllowlistSchema = v.array(
  v.strictObject({
    id: v.pipe(
      v.string(),
      v.regex(
        /^[^#]+#[^#]+#[^#]+#(?:retry|timeout)$/u,
        "id is file#job#step#rule",
      ),
    ),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1, "reason is required")),
  }),
);

/** The allowlisted violation ids; duplicates and blank reasons fail. */
export const parseAllowlist = (text: string, label: string): string[] => {
  const parsed = v.safeParse(AllowlistSchema, JSON.parse(text));
  if (!parsed.success) {
    return panic(
      `${label}: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const ids = parsed.output.map((entry) => entry.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    return panic(`${label}: duplicate entry ${duplicate}`);
  }
  return ids;
};

export type NetworkStepReport = {
  errors: string[];
  allowlisted: number;
};

/** Violations the allowlist does not cover, and allowlist entries now stale. */
export const evaluate = (
  violations: readonly NetworkViolation[],
  allowlist: readonly string[],
): NetworkStepReport => {
  const allowed = new Set(allowlist);
  const found = new Set(violations.map((violation) => violation.id));
  return {
    errors: [
      ...violations
        .filter((violation) => !allowed.has(violation.id))
        .map((violation) => violation.message),
      ...allowlist
        .filter((id) => !found.has(id))
        .map(
          (id) =>
            `${ALLOWLIST_REL}: stale entry ${id}; the step complies or is gone, so delete the entry`,
        ),
    ],
    allowlisted: allowlist.filter((id) => found.has(id)).length,
  };
};

export const repositoryFiles = (root: string) => ({
  workflows: [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].toSorted(),
  actions: [
    ...new Bun.Glob(".github/actions/**/action.{yml,yaml}").scanSync({
      cwd: root,
    }),
  ].toSorted(),
});

export const diskRepository = (root: string): Repository => ({
  read: (file) => {
    const absolute = path.join(root, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
  },
  glob: (pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root })],
});

const baseAllowlist = (root: string, ref: string): string[] | null => {
  const shown = Bun.spawnSync(["git", "show", `${ref}:${ALLOWLIST_REL}`], {
    cwd: root,
    stderr: "pipe",
  });
  if (shown.exitCode !== 0) {
    const stderr = shown.stderr.toString();
    if (/exists on disk, but not in|does not exist in/u.test(stderr)) {
      return null;
    }
    return panic(`git show ${ref}:${ALLOWLIST_REL} failed: ${stderr}`);
  }
  return parseAllowlist(shown.stdout.toString(), `${ref}:${ALLOWLIST_REL}`);
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
  if (baseIndex !== -1 && (base === undefined || base === "")) {
    process.stderr.write("--base requires a ref\n");
    process.exit(2);
  }
  const repo = diskRepository(root);
  const { workflows, actions } = repositoryFiles(root);
  const allowlist = parseAllowlist(
    repo.read(ALLOWLIST_REL) ?? "[]",
    ALLOWLIST_REL,
  );
  const report = evaluate(
    networkViolations(repo, workflows, actions),
    allowlist,
  );
  const added =
    base === undefined
      ? []
      : addedEntries(allowlist, baseAllowlist(root, base)).map(
          (id) =>
            `${ALLOWLIST_REL}: ${id} is not in ${base}; the allowlist only shrinks, so retry the fetch and give the step a timeout instead`,
        );
  const errors = [...report.errors, ...added];
  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }
  if (errors.length > 0) {
    process.exit(1);
  }
  process.stdout.write(
    `CI network steps: OK. ${report.allowlisted} allowlisted ${report.allowlisted === 1 ? "entry" : "entries"}.\n`,
  );
}
