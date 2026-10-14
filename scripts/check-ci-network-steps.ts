// Every network fetch in CI either retries or is served by a cache-first
// action, and every step that fetches has its own deadline.
//
// Rules, checked over every workflow and repository composite action:
// - retry: a `run:` command that fetches (curl, wget, cargo fetch/install,
//   bun install/ci/add, npm/pnpm/yarn install, npx/bunx of a remote package,
//   docker pull, playwright install, gh release download, git clone) runs
//   through scripts/retry.sh, or scripts/gh-retry.sh for the GitHub API. A
//   curl that carries its own `--retry N --retry-all-errors` budget counts as
//   retried, and a curl or wget that only names a loopback address is a
//   readiness probe, not a fetch. Repository shell scripts a step invokes are
//   scanned too; a script invoked through retry.sh is retried as a whole.
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
  {
    kind: "remote package runner",
    pattern:
      /\b(?:npx|bunx|bun\s+x)\s+(?:(?:--yes|-y|--package|-p)(?=[\s=])|(?:-\S+\s+)*@?[\w.-]+(?:\/[\w.-]+)?@[\w^~.-]+)/u,
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

const RETRY_WRAPPER = /(?:gh-)?retry\.sh\b|\$\{?\w*(?:retry|RETRY)\w*\}?/u;
const NATIVE_CURL_RETRY = /--retry[\s=]+[1-9]/u;
const LOOPBACK = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/u;
const REMOTE_URL =
  /\bhttps?:\/\/(?!localhost\b|127\.0\.0\.1\b|0\.0\.0\.0\b|\[::1\])/u;
const PROSE = /^\s*(?:echo|printf|:)(?:\s|$)/u;

// A `case` arm's pattern list (`a|b|scripts/x.sh)`) names paths, not commands.
const CASE_PATTERN = /^\s*[^\s"'`$()=]+(?:\|[^\s"'`$()=]+)*\)/u;

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
    });

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
  return parts.map((part) => part.trim()).filter((part) => part !== "");
};

/** The fetches one shell source runs, and whether each one retries. */
export const scanShell = (source: string, label: string): NetworkFetch[] =>
  logicalLines(source).flatMap((line) =>
    segments(line).flatMap((segment): NetworkFetch[] => {
      if (PROSE.test(segment)) {
        return [];
      }
      return FETCH_PATTERNS.flatMap(({ kind, pattern }) => {
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
        const before = segment.slice(0, match.index + match[0].length);
        const wrapped =
          RETRY_WRAPPER.test(before) ||
          (kind === "curl" &&
            NATIVE_CURL_RETRY.test(segment) &&
            segment.includes("--retry-all-errors"));
        return [{ kind, wrapped, command: segment, source: label }];
      });
    }),
  );

type ScriptReference = { file: string; wrapped: boolean };

const SCRIPT_REFERENCE =
  /(?:(?<action>\$\{?GITHUB_ACTION_PATH\}?|\$\{\{\s*github\.action_path\s*\}\})\/(?<relative>[\w./-]+\.sh)|(?<=^|[\s"'=(]|\$\{?GITHUB_WORKSPACE\}?\/|\.[\w-]+\/)(?<rooted>(?:scripts|\.github)\/[\w./-]+\.sh))/gu;
const RETRY_SCRIPTS = new Set(["scripts/retry.sh", "scripts/gh-retry.sh"]);
// Only a script in command position runs: optional assignments, a retry
// wrapper, an interpreter and a path prefix may precede it. A path quoted in
// a scope list or a message is data.
const INVOCATION_PREFIX =
  /^(?:[A-Za-z_]\w*=(?:\$\(|"[^"]*"|'[^']*'|\S*)\s*)*(?:(?:(?:bash|sh)\s+)?(?:\S*(?:gh-)?retry\.sh["']?\s+|"?\$\{?\w*(?:retry|RETRY)\w*\}?"?\s+))?(?:(?:bash|sh|exec|source|\.)\s+(?:-\S+\s+)*)?["']?(?:\$\{?GITHUB_WORKSPACE\}?\/|\.[\w-]+\/|\.\/)*$/u;

const ACTION_PATH =
  /["']?\$\{?\{?\s*(?:GITHUB_ACTION_PATH|github\.action_path)\s*\}?\}?$/u;

const referencedFile = (
  rooted: string | undefined,
  relative: string | undefined,
  actionDir: string | null,
): string | undefined => {
  if (relative === undefined) {
    return rooted;
  }
  if (actionDir === null) {
    return undefined;
  }
  return path.posix.normalize(path.posix.join(actionDir, relative));
};

/** Repository shell scripts a source invokes, resolved from the repo root. */
const scriptReferences = (
  source: string,
  actionDir: string | null,
): ScriptReference[] =>
  logicalLines(source).flatMap((line) =>
    segments(line).flatMap((segment) => {
      if (PROSE.test(segment)) {
        return [];
      }
      return [...segment.matchAll(SCRIPT_REFERENCE)].flatMap((match) => {
        const groups = match.groups ?? {};
        const relative = groups["relative"];
        const file = referencedFile(groups["rooted"], relative, actionDir);
        const prefix = segment.slice(0, match.index);
        const invocation =
          relative === undefined ? prefix : prefix.replace(ACTION_PATH, "");
        // Test scripts stub the network commands they exercise.
        if (
          file === undefined ||
          RETRY_SCRIPTS.has(file) ||
          file.endsWith(".test.sh") ||
          !INVOCATION_PREFIX.test(invocation)
        ) {
          return [];
        }
        const wrapped = RETRY_WRAPPER.test(prefix);
        return [{ file, wrapped }];
      });
    }),
  );

type Repository = {
  read: (file: string) => string | null;
};

const MAX_SCRIPT_DEPTH = 4;

/** Fetches in a run step, including the repository scripts it invokes. */
export const runFetches = (
  repo: Repository,
  run: string,
  actionDir: string | null,
  label: string,
): NetworkFetch[] => {
  const fetches = scanShell(run, label);
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
    for (const reference of scriptReferences(source, dir)) {
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
      for (const fetch of scanShell(script, reference.file)) {
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
        const fetches = runFetches(repo, run, dir, file);
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
          const own = runFetches(repo, run, null, file);
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
      : addedEntries(allowlist, baseAllowlist(root, base));
  const errors = [
    ...report.errors,
    ...added.map(
      (id) =>
        `${ALLOWLIST_REL}: ${id} is not in ${base}; the allowlist only shrinks, so retry the fetch and give the step a timeout instead`,
    ),
  ];
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
