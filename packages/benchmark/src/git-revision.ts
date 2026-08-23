import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertSealedAggregateReport,
  renderSealedAggregateMarkdown,
  serializeSealedAggregateReport,
} from "./sealed-report";

const git = (
  cwd: string,
  args: readonly string[],
): { readonly ok: boolean; readonly stdout: Uint8Array } => {
  try {
    const child = Bun.spawnSync(["git", ...args], { cwd });
    return {
      ok: child.success && child.exitCode === 0,
      stdout: child.stdout ?? new Uint8Array(),
    };
  } catch {
    return { ok: false, stdout: new Uint8Array() };
  }
};

const text = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).trim();

const GENERATED_AGGREGATE_REPORT =
  /^packages\/benchmark\/results\/blind\/(?:(redactionbench|meddocan|multigrassco|german-ler)\/)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(json|md)$/u;

const generatedAggregateReport = (
  root: string,
  path: string,
  expectedSourceGitSha: string,
): boolean => {
  const match = GENERATED_AGGREGATE_REPORT.exec(path);
  if (match === null) return false;
  const suite = match[1];
  const stamp = match[2];
  if (stamp === undefined) return false;
  const prefix = `packages/benchmark/results/blind/${suite === undefined ? "" : `${suite}/`}${stamp}`;
  try {
    const json = readFileSync(join(root, `${prefix}.json`), "utf8");
    const markdown = readFileSync(join(root, `${prefix}.md`), "utf8");
    const report: unknown = JSON.parse(json);
    assertSealedAggregateReport(report);
    let expectedCorpus:
      | "german-ler"
      | "meddocan"
      | "multigrassco"
      | "redactionbench"
      | "tab-echr" = "tab-echr";
    if (suite === "redactionbench") expectedCorpus = "redactionbench";
    if (suite === "meddocan") expectedCorpus = "meddocan";
    if (suite === "multigrassco") expectedCorpus = "multigrassco";
    if (suite === "german-ler") expectedCorpus = "german-ler";
    return (
      report.corpus.id === expectedCorpus &&
      report.sourceGitSha === expectedSourceGitSha &&
      report.createdAt.replace(/[:.]/gu, "-") === stamp &&
      serializeSealedAggregateReport(report) === json &&
      renderSealedAggregateMarkdown(report) === markdown
    );
  } catch {
    return false;
  }
};

type RepositoryState = {
  readonly fullSha: string;
  readonly shortSha: string;
  readonly dirty: boolean;
};

const repositoryState = (
  cwd: string = import.meta.dir,
): RepositoryState | undefined => {
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  const fullShaResult = git(cwd, ["rev-parse", "HEAD"]);
  const shortShaResult = git(cwd, ["rev-parse", "--short", "HEAD"]);
  if (!rootResult.ok || !fullShaResult.ok || !shortShaResult.ok) {
    return undefined;
  }
  const root = text(rootResult.stdout);
  const fullSha = text(fullShaResult.stdout);
  const shortSha = text(shortShaResult.stdout);
  if (
    root === "" ||
    !/^[a-f0-9]{40}$/u.test(fullSha) ||
    !/^[a-f0-9]+$/u.test(shortSha)
  ) {
    return undefined;
  }

  const unstaged = git(root, ["diff", "--quiet", "--"]);
  const staged = git(root, ["diff", "--cached", "--quiet", "--"]);
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!untracked.ok) return undefined;

  const relevantUntracked = new TextDecoder()
    .decode(untracked.stdout)
    .split("\0")
    .some(
      (path) => path !== "" && !generatedAggregateReport(root, path, fullSha),
    );
  return {
    fullSha,
    shortSha,
    dirty: !unstaged.ok || !staged.ok || relevantUntracked,
  };
};

/** Ignore only canonical aggregate artifacts emitted by an earlier sealed phase. */
export const benchmarkGitRevision = (cwd: string = import.meta.dir): string => {
  const state = repositoryState(cwd);
  if (state === undefined) return "no-git";
  return state.dirty ? `${state.shortSha}-dirty` : state.shortSha;
};

/** Resolve the immutable source revision for a sealed run, failing closed. */
export const benchmarkSourceGitSha = (
  cwd: string = import.meta.dir,
): string => {
  const state = repositoryState(cwd);
  if (state === undefined) {
    throw new Error("sealed benchmarks require a valid Git source revision");
  }
  if (state.dirty) {
    throw new Error("sealed benchmarks require a clean Git source tree");
  }
  return state.fullSha;
};
