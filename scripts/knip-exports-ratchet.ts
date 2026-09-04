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
// Modes:
//   bun scripts/knip-exports-ratchet.ts           report current vs baseline
//   bun scripts/knip-exports-ratchet.ts --check   CI gate (exit 1 on a rise)
//   bun scripts/knip-exports-ratchet.ts --write   regenerate the baseline

import { panic, Result } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(
  import.meta.dir,
  "knip-exports-baseline.json",
);
const BASELINE_REL = "scripts/knip-exports-baseline.json";
const WRITE_HINT = "bun scripts/knip-exports-ratchet.ts --write";

// The issue types this budget owns. `nsExports` is off by default in knip, so
// it has to be named explicitly.
const ISSUE_TYPES = ["exports", "types", "nsExports"] as const;

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

const issueCount = (entry: Record<string, unknown>): number => {
  let count = 0;
  for (const type of ISSUE_TYPES) {
    const issues = entry[type];
    if (issues !== undefined && !Array.isArray(issues)) {
      panic(`knip json reporter returned a non-array ${type} entry`);
    }
    count += Array.isArray(issues) ? issues.length : 0;
  }
  return count;
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
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    panic("knip json reporter output has no issues array");
  }

  const summary: Record<
    string,
    { count: number; files: Record<string, number> }
  > = {};
  for (const entry of report.issues) {
    if (!isRecord(entry) || typeof entry.file !== "string") {
      panic("knip json reporter returned an entry without a file path");
    }
    const count = issueCount(entry);
    if (count === 0) {
      continue;
    }
    const workspace = workspaceOf(entry.file);
    const snapshot = summary[workspace] ?? { count: 0, files: {} };
    snapshot.count += count;
    snapshot.files[entry.file] = (snapshot.files[entry.file] ?? 0) + count;
    summary[workspace] = snapshot;
  }
  return sortedSummary(summary);
};

// Symbol names per file, so a failing gate names what to delete rather than
// only how many.
export const collectIssueSymbols = (
  report: unknown,
): Record<string, readonly string[]> => {
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    panic("knip json reporter output has no issues array");
  }

  const symbols: Record<string, string[]> = {};
  for (const entry of report.issues) {
    if (!isRecord(entry) || typeof entry.file !== "string") {
      continue;
    }
    for (const type of ISSUE_TYPES) {
      const issues = entry[type];
      if (!Array.isArray(issues)) {
        continue;
      }
      for (const issue of issues) {
        const name = isRecord(issue) ? issue.name : undefined;
        const named = symbols[entry.file] ?? [];
        named.push(
          `${typeof name === "string" ? name : "<unnamed>"} (${type})`,
        );
        symbols[entry.file] = named;
      }
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
    if (!isRecord(snapshot) || !isRecord(snapshot.files)) {
      panic(`${BASELINE_REL} entry ${workspace} must carry count and files`);
    }
    const files: Record<string, number> = {};
    let total = 0;
    for (const [file, value] of Object.entries(snapshot.files)) {
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
    const declared = snapshot.count;
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
      `path. If the increase is genuinely justified, run \`${WRITE_HINT}\` and\n` +
      `commit ${BASELINE_REL} with a rationale in your PR.`,
  );
  return 1;
};

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    process.exit(runWrite());
  }
  process.exit(process.argv.includes("--check") ? runCheck() : runReport());
}
