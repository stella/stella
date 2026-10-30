// Push scope for the changed-file autofix.
//
// A pull request's first autofix run fixes every file the pull request
// changed. Later pushes start from the newest earlier commit that autofix left
// settled: one whose "Autofix changed files" job succeeded (fail-fast fails
// that job whenever it pushes a fix, so success means nothing was left to
// fix), or an autofix commit itself. Files whose content is unchanged since
// that commit were already fixed, so each fixer runs only for what the push
// changed:
//
// - format and lint: pull request files the push changed;
// - generators: the pull request plan, kept only when the push changed one of
//   the generator's inputs or outputs (or an upstream generator's), so a
//   merge from the base branch still regenerates outputs the pull request
//   owns;
// - stale-baseline pruning: only when the scoped files include source a
//   baseline writer scans, or a prunable baseline itself.
//
// Without a settled commit the push scope is the whole pull request, which is
// the behaviour this file narrows. A push that changes what the formatter or
// linter reads (their config, rule plugins, type configs, dependencies or the
// fixer scripts), for example through a base-branch merge, refixes every pull
// request file: unchanged files can now format or lint differently.

import { PRUNABLE_BASELINES } from "./autofix-baseline-prune";
import {
  type Generator,
  GENERATORS,
  generatorsForFiles,
  orderGenerators,
} from "./generated-files";

export const AUTOFIX_BOT = "autofix-ci[bot]";
export const AUTOFIX_COMMIT_SUBJECT = "chore: autofix files";

const PRUNE_SOURCE = /\.(?:[cm]?[jt]sx?|sql)$/u;
// Oxfmt's supported text formats, plus source files handled by oxlint. Paths
// outside this set can still select a generator or baseline pruner, but are not
// themselves passed to a fixer.
const FIXABLE_SOURCE =
  /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|mdx?|html?|vue|svelte|astro|css|scss|less|graphql|gql)$/u;

export const isAutofixablePath = (file: string) => FIXABLE_SOURCE.test(file);
const PRUNABLE_PATHS = new Set<string>(
  PRUNABLE_BASELINES.map(({ path }) => path),
);

// What the format and lint fixers read besides the files they fix. Generator
// sources need no entry: each generator declares them as inputs.
const FIXER_INPUTS = [
  "bunfig.toml",
  "oxlint.config.ts",
  ".oxlint-plugins/**",
  "scripts/oxlint-presets/**",
  "**/tsconfig*.json",
  "**/package.json",
  "bun.lock",
  "patches/**",
  "types/**",
  ".github/workflows/autofix.yml",
  "scripts/autofix-*.ts",
  "scripts/ci-generated-sources.ts",
  "scripts/typecheck-coverage.ts",
] as const;

/** Whether a change among `files` can alter what format or lint produce. */
export const fixerInputChanged = (files: readonly string[]) =>
  files.some((file) =>
    FIXER_INPUTS.some((glob) => new Bun.Glob(glob).match(file)),
  );

/** Whether a stale-baseline writer can see a change among `files`. */
const pruneInputChanged = (files: readonly string[]) =>
  files.some((file) => PRUNE_SOURCE.test(file) || PRUNABLE_PATHS.has(file));

export type AutofixPlan = {
  generators: Generator[];
  /** Pull request files that changed since the settled commit. */
  scoped: string[];
  /** The push changed a fixer input, so every pull request file is refixed. */
  refix: boolean;
  prune: boolean;
  /** False only when no fixer, generator or pruner has anything to do. */
  needed: boolean;
};

export const planAutofix = ({
  pullRequestFiles,
  pushFiles,
  all = false,
}: {
  pullRequestFiles: readonly string[];
  /** Files changed since the settled commit; null when none was found. */
  pushFiles: readonly string[] | null;
  /** The files API stops at 3000 entries; a capped list runs everything. */
  all?: boolean;
}): AutofixPlan => {
  const push = all ? null : pushFiles;
  let generators: Generator[];
  if (all) {
    generators = GENERATORS.filter((generator) => generator.autofix);
  } else if (push === null) {
    generators = generatorsForFiles(pullRequestFiles);
  } else {
    const touched = new Set(generatorsForFiles(push).map(({ id }) => id));
    generators = generatorsForFiles(pullRequestFiles).filter(({ id }) =>
      touched.has(id),
    );
  }
  const refix = push !== null && fixerInputChanged(push);
  const pushed = push === null || refix ? null : new Set(push);
  const candidates =
    pushed === null
      ? [...pullRequestFiles]
      : pullRequestFiles.filter((file) => pushed.has(file));
  const scoped = candidates.filter(isAutofixablePath);
  return {
    generators: orderGenerators(generators),
    scoped,
    refix,
    prune: pruneInputChanged(candidates),
    needed:
      generators.length > 0 ||
      scoped.length > 0 ||
      pruneInputChanged(candidates),
  };
};

export type AncestorCommit = { sha: string; author: string; subject: string };

/**
 * Newest settled ancestor, walking first parents newest first. An autofix
 * commit is settled by construction: the job that pushed it ran every fixer
 * first. Any other commit needs a successful autofix job of its own; at most
 * `maxQueries` commits are looked up before falling back to the full scope.
 */
export const settledAncestor = (
  ancestors: readonly AncestorCommit[],
  succeeded: (sha: string) => boolean,
  maxQueries: number,
): string | null => {
  let queries = 0;
  for (const commit of ancestors) {
    if (
      commit.author === AUTOFIX_BOT &&
      commit.subject === AUTOFIX_COMMIT_SUBJECT
    ) {
      return commit.sha;
    }
    if (queries >= maxQueries) {
      return null;
    }
    queries += 1;
    if (succeeded(commit.sha)) {
      return commit.sha;
    }
  }
  return null;
};

const AUTOFIX_CHECK = "Autofix changed files";
const MAX_ANCESTORS = 20;
const MAX_QUERIES = 8;

const firstParentAncestors = (): AncestorCommit[] => {
  const log = Bun.spawnSync(
    [
      "git",
      "log",
      "--first-parent",
      "--skip=1",
      `--max-count=${MAX_ANCESTORS}`,
      "--format=%H%x09%an%x09%s",
      "HEAD",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (log.exitCode !== 0) {
    return [];
  }
  return log.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", author = "", ...subject] = line.split("\t");
      return { sha, author, subject: subject.join("\t") };
    });
};

const autofixSucceeded =
  (ghRetry: string, repository: string) =>
  (sha: string): boolean => {
    const result = Bun.spawnSync(
      [
        "bash",
        ghRetry,
        "api",
        `repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(AUTOFIX_CHECK)}&filter=latest`,
        "--jq",
        '[.check_runs[] | select(.app.slug == "github-actions" and .conclusion == "success")] | length',
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    // An unreadable answer only widens the scope.
    return result.exitCode === 0 && Number(result.stdout.toString()) > 0;
  };

if (import.meta.main) {
  const [mode, ghRetry, repository] = process.argv.slice(2);
  if (mode !== "settled" || !ghRetry || !repository) {
    console.error(
      "Usage: bun scripts/autofix-push-scope.ts settled <gh-retry.sh> <owner/repo>",
    );
    process.exit(1);
  }
  const since = settledAncestor(
    firstParentAncestors(),
    autofixSucceeded(ghRetry, repository),
    MAX_QUERIES,
  );
  console.log(`since=${since ?? ""}`);
}
