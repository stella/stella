#!/usr/bin/env bun

// Dead-export budget, one decrease-only count per workspace.
//
// knip's `exports`/`types`/`nsExports` checks were enforced on packages/cli
// alone: everywhere else an exported helper nothing calls was invisible. A
// repo-wide flip would have failed on day one, so the surface is budgeted
// instead — today's count per workspace is committed, a rise fails CI, and a
// fall prompts `--write` to lock the improvement in. packages/cli keeps its own
// stricter CI step at zero.
//
// One knip run covers every workspace: knip discovers them from the root
// package.json `workspaces`, so no per-workspace enrolment is needed. The CLI
// `--include` wins over the `exclude` in knip.json (knip drops a configured
// exclusion that the command line explicitly includes), which is what lets the
// three issue types report here while staying off elsewhere.
//
// A budget that any run can raise is not a budget: `--write` refuses to record
// a higher count unless `--allow-increase` says so deliberately, which turns
// "the number went up" into a visible line in the diff and a justification in
// the pull request. The same review rule governs `scripts/ratchet-baseline.json`.
//
// Modes:
//   bun scripts/knip-exports-ratchet.ts           report current vs baseline
//   bun scripts/knip-exports-ratchet.ts --check   CI gate (exit 1 on a rise)
//   bun scripts/knip-exports-ratchet.ts --write   regenerate the baseline
//   bun scripts/knip-exports-ratchet.ts --write --allow-increase
//                                                 record a justified rise

import { panic, Result } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_REL = BASELINE_PATHS.knipExports;
const BASELINE_PATH = path.resolve(REPO_ROOT, BASELINE_REL);
const WRITE_HINT = "bun scripts/knip-exports-ratchet.ts --write";
const ALLOW_INCREASE_FLAG = "--allow-increase";

// The issue types this budget owns. `nsExports` is off by default in knip, so
// it has to be named explicitly.
const ISSUE_TYPES = ["exports", "types", "nsExports"] as const;

type IssueType = (typeof ISSUE_TYPES)[number];

const ROOT_WORKSPACE = ".";
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

export type WorkspaceSnapshot = {
  readonly count: number;
  readonly files: Record<string, number>;
};

export type Summary = Record<string, WorkspaceSnapshot>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// `apps/web/src/x.ts` -> `apps/web`; `scripts/x.ts` -> `.`.
const workspaceOf = (file: string): string => {
  const [root, name] = file.split("/");
  return root !== undefined &&
    name !== undefined &&
    WORKSPACE_ROOTS.some((candidate) => candidate === root)
    ? `${root}/${name}`
    : ROOT_WORKSPACE;
};

// One reported symbol, carrying the issue type it was reported under.
type KnipIssue = {
  readonly type: IssueType;
  readonly name: string;
};

type KnipFileReport = {
  readonly file: string;
  readonly issues: readonly KnipIssue[];
};

const UNNAMED_SYMBOL = "<unnamed>";

// Narrow the reporter's JSON into the rows both consumers read, once, so the
// untyped shape stops at this function instead of leaking into the counting.
const parseKnipReport = (report: unknown): readonly KnipFileReport[] => {
  if (!isRecord(report) || !Array.isArray(report["issues"])) {
    panic("knip json reporter output has no issues array");
  }

  const rows: KnipFileReport[] = [];
  for (const entry of report["issues"]) {
    const file = isRecord(entry) ? entry["file"] : undefined;
    if (!isRecord(entry) || typeof file !== "string") {
      panic("knip json reporter returned an entry without a file path");
    }
    const issues: KnipIssue[] = [];
    for (const type of ISSUE_TYPES) {
      const reported = entry[type];
      if (reported === undefined) {
        continue;
      }
      if (!Array.isArray(reported)) {
        panic(`knip json reporter returned a non-array ${type} entry`);
      }
      for (const issue of reported) {
        const name = isRecord(issue) ? issue["name"] : undefined;
        issues.push({
          type,
          name: typeof name === "string" ? name : UNNAMED_SYMBOL,
        });
      }
    }
    rows.push({ file, issues });
  }
  return rows;
};

const sortedSummary = (summary: Summary): Summary => {
  const sorted: Summary = {};
  for (const workspace of Object.keys(summary).sort()) {
    const snapshot =
      summary[workspace] ?? panic(`workspace ${workspace} vanished`);
    const files: Record<string, number> = {};
    for (const file of Object.keys(snapshot.files).sort()) {
      files[file] = snapshot.files[file] ?? panic(`file ${file} vanished`);
    }
    sorted[workspace] = { count: snapshot.count, files };
  }
  return sorted;
};

// The knip json reporter emits `{ issues: [{ file, exports, types, ... }] }`,
// one entry per file, each issue type an array of symbols.
export const summarizeKnipReport = (report: unknown): Summary => {
  const summary: Record<
    string,
    { count: number; files: Record<string, number> }
  > = {};
  for (const { file, issues } of parseKnipReport(report)) {
    if (issues.length === 0) {
      continue;
    }
    const workspace = workspaceOf(file);
    const snapshot = summary[workspace] ?? { count: 0, files: {} };
    snapshot.count += issues.length;
    snapshot.files[file] = (snapshot.files[file] ?? 0) + issues.length;
    summary[workspace] = snapshot;
  }
  return sortedSummary(summary);
};

// Symbol names per file, so a failing gate names what to delete rather than
// only how many.
export const collectIssueSymbols = (
  report: unknown,
): Record<string, readonly string[]> => {
  const symbols: Record<string, string[]> = {};
  for (const { file, issues } of parseKnipReport(report)) {
    for (const { type, name } of issues) {
      const named = symbols[file] ?? [];
      named.push(`${name} (${type})`);
      symbols[file] = named;
    }
  }
  return symbols;
};

// --- Diffing ----------------------------------------------------------------

type WorkspaceStatus = "ok" | "regressed" | "dropped";

export type WorkspaceDiff = {
  readonly workspace: string;
  readonly status: WorkspaceStatus;
  readonly current: number;
  readonly baseline: number;
  readonly regressedFiles: readonly {
    readonly file: string;
    readonly from: number;
    readonly to: number;
  }[];
};

const workspaceStatus = (
  current: number,
  baseline: number,
): WorkspaceStatus => {
  if (current > baseline) {
    return "regressed";
  }
  if (current < baseline) {
    return "dropped";
  }
  return "ok";
};

export const diffSummaries = (
  current: Summary,
  baseline: Summary,
): readonly WorkspaceDiff[] => {
  const workspaces = [
    ...new Set([...Object.keys(current), ...Object.keys(baseline)]),
  ].sort();

  return workspaces.map((workspace) => {
    const now = current[workspace] ?? { count: 0, files: {} };
    const before = baseline[workspace] ?? { count: 0, files: {} };
    const regressedFiles = Object.entries(now.files)
      .flatMap(([file, to]) => {
        const from = before.files[file] ?? 0;
        return to > from ? [{ file, from, to }] : [];
      })
      .sort((a, b) => a.file.localeCompare(b.file));

    return {
      workspace,
      status: workspaceStatus(now.count, before.count),
      current: now.count,
      baseline: before.count,
      regressedFiles,
    };
  });
};

// The workspaces `--write` may not record without an explicit flag.
export const increasedWorkspaces = (
  current: Summary,
  baseline: Summary,
): readonly WorkspaceDiff[] =>
  diffSummaries(current, baseline).filter(
    ({ status }) => status === "regressed",
  );

// --- Baseline ---------------------------------------------------------------

const readBaseline = (): Summary => {
  const parsed = Result.try((): unknown =>
    JSON.parse(readFileSync(BASELINE_PATH, "utf-8")),
  );
  if (Result.isError(parsed)) {
    panic(`${BASELINE_REL} is not valid JSON; run \`${WRITE_HINT}\``);
  }
  if (!isRecord(parsed.value)) {
    panic(`${BASELINE_REL} must be a JSON object`);
  }

  const baseline: Summary = {};
  for (const [workspace, snapshot] of Object.entries(parsed.value)) {
    const reportedFiles = isRecord(snapshot) ? snapshot["files"] : undefined;
    if (!isRecord(snapshot) || !isRecord(reportedFiles)) {
      panic(`${BASELINE_REL} entry ${workspace} must carry count and files`);
    }
    const files: Record<string, number> = {};
    let total = 0;
    for (const [file, value] of Object.entries(reportedFiles)) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        panic(
          `${BASELINE_REL} entry ${workspace} has an invalid count for ${file}`,
        );
      }
      files[file] = value;
      total += value;
    }
    const declared = snapshot["count"];
    if (typeof declared !== "number" || declared !== total) {
      panic(
        `${BASELINE_REL} entry ${workspace} count ${String(declared)} does not equal its per-file total ${total}`,
      );
    }
    baseline[workspace] = { count: total, files };
  }
  return baseline;
};

// --- knip -------------------------------------------------------------------

const runKnip = (): unknown => {
  const knip = Bun.spawnSync({
    cmd: [
      "bun",
      "--no-env-file",
      "run",
      "knip",
      "--no-progress",
      "--include",
      ISSUE_TYPES.join(","),
      "--reporter",
      "json",
    ],
    cwd: REPO_ROOT,
    // knip resolves config that touches the database URL; a deliberately
    // invalid one keeps the run from reaching any real service.
    env: { ...process.env, DATABASE_URL: "postgresql://invalid" },
    stdout: "pipe",
    stderr: "pipe",
  });

  // knip exits non-zero whenever it reports issues, which is the normal case
  // for a budget: only unparsable output is a failure.
  const stdout = knip.stdout.toString();
  const parsed = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(parsed)) {
    panic(
      `knip did not produce JSON output:\n${knip.stderr.toString().trim() || stdout.trim()}`,
    );
  }
  return parsed.value;
};

// --- Modes ------------------------------------------------------------------

const totalOf = (summary: Summary): number =>
  Object.values(summary).reduce((total, { count }) => total + count, 0);

const formatDelta = (delta: number): string =>
  delta > 0 ? `+${delta}` : String(delta);

const runReport = (): number => {
  const current = summarizeKnipReport(runKnip());
  const baseline = readBaseline();
  console.log("knip dead exports: current counts (vs baseline)\n");
  for (const diff of diffSummaries(current, baseline)) {
    console.log(
      `  ${diff.workspace.padEnd(32)} ${String(diff.current).padStart(5)}  (baseline ${diff.baseline}, ${formatDelta(diff.current - diff.baseline)})`,
    );
  }
  console.log(
    `\n  ${"total".padEnd(32)} ${String(totalOf(current)).padStart(5)}`,
  );
  return 0;
};

const runWrite = (): number => {
  const current = summarizeKnipReport(runKnip());
  // A missing baseline is the first seed, not a rise.
  const risen = increasedWorkspaces(
    current,
    existsSync(BASELINE_PATH) ? readBaseline() : {},
  );
  if (risen.length > 0 && !process.argv.includes(ALLOW_INCREASE_FLAG)) {
    console.error(
      `Refusing to raise ${BASELINE_REL}. These workspaces rose:\n`,
    );
    for (const diff of risen) {
      console.error(
        `  ${diff.workspace}: ${diff.baseline} -> ${diff.current} (+${diff.current - diff.baseline})`,
      );
    }
    console.error(
      `\nDelete the unused exports instead. If the increase is genuinely\n` +
        `justified, rerun with \`${WRITE_HINT} ${ALLOW_INCREASE_FLAG}\` and say why\n` +
        "in your pull request.",
    );
    return 1;
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${BASELINE_REL}:`);
  for (const [workspace, snapshot] of Object.entries(current)) {
    console.log(
      `  ${workspace.padEnd(32)} ${String(snapshot.count).padStart(5)} across ${Object.keys(snapshot.files).length} file(s)`,
    );
  }
  console.log(
    `  ${"total".padEnd(32)} ${String(totalOf(current)).padStart(5)}`,
  );
  return 0;
};

const runCheck = (): number => {
  const report = runKnip();
  const current = summarizeKnipReport(report);
  const diffs = diffSummaries(current, readBaseline());
  const symbols = collectIssueSymbols(report);

  for (const diff of diffs.filter(({ status }) => status === "dropped")) {
    console.log(
      `knip dead exports: ${diff.workspace} dropped ${diff.baseline} -> ${diff.current}. Nice — run \`${WRITE_HINT}\` and commit ${BASELINE_REL} to lock it in.`,
    );
  }

  const regressions = diffs.filter(({ status }) => status === "regressed");
  if (regressions.length === 0) {
    console.log(
      `knip dead exports --check: OK. ${diffs.length} workspace(s) at or below baseline.`,
    );
    return 0;
  }

  console.error(
    "\nknip dead exports --check: workspace(s) rose above baseline:\n",
  );
  for (const diff of regressions) {
    console.error(
      `  ${diff.workspace}: ${diff.baseline} -> ${diff.current} (+${diff.current - diff.baseline})`,
    );
    for (const { file, from, to } of diff.regressedFiles) {
      console.error(`      ${file}: ${from} -> ${to}`);
      for (const symbol of symbols[file] ?? []) {
        console.error(`        ${symbol}`);
      }
    }
  }
  console.error(
    "\nDelete the unused export, or reference it from a real runtime or test\n" +
      `path. If the increase is genuinely justified, run\n` +
      `\`${WRITE_HINT} ${ALLOW_INCREASE_FLAG}\` and commit ${BASELINE_REL} with a\n` +
      "rationale in your pull request.",
  );
  return 1;
};

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    process.exit(runWrite());
  }
  process.exit(process.argv.includes("--check") ? runCheck() : runReport());
}
