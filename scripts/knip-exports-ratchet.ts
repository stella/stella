#!/usr/bin/env bun

// Repo-wide dead-export gate (`exports`, `types`, `nsExports`) enforced at zero.
//
// One knip run covers every workspace: knip discovers them from the root
// package.json `workspaces`, so no per-workspace enrolment is needed. The CLI
// `--include` wins over the `exclude` in knip.json (knip drops a configured
// exclusion that the command line explicitly includes), which is what lets the
// three issue types report here while staying off elsewhere.
//
// Modes:
//   bun scripts/knip-exports-ratchet.ts           report current counts
//   bun scripts/knip-exports-ratchet.ts --check   CI gate (exit 1 on any issue)

import { panic, Result } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

import { validateKnipGeneratedEntries } from "./knip-generated-entries";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// The issue types this gate owns. `nsExports` is off by default in knip, so it
// has to be named explicitly.
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

type KnipIssue = {
  readonly type: IssueType;
  readonly name: string;
};

type KnipFileReport = {
  readonly file: string;
  readonly issues: readonly KnipIssue[];
};

const UNNAMED_SYMBOL = "<unnamed>";

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

const sortedSummary = (summary: Summary): Summary =>
  Object.fromEntries(
    Object.keys(summary)
      .toSorted()
      .map((workspace) => {
        const snapshot =
          summary[workspace] ?? panic(`workspace ${workspace} vanished`);
        const files = Object.fromEntries(
          Object.keys(snapshot.files)
            .toSorted()
            .map(
              (file) =>
                [
                  file,
                  snapshot.files[file] ?? panic(`file ${file} vanished`),
                ] as const,
            ),
        );
        return [workspace, { count: snapshot.count, files }] as const;
      }),
  );

// The knip json reporter emits `{ issues: [{ file, exports, types, ... }] }`,
// one entry per file, each issue type an array of symbols.
export const summarizeKnipReport = (report: unknown): Summary => {
  const summary = new Map<
    string,
    { count: number; files: Map<string, number> }
  >();
  for (const { file, issues } of parseKnipReport(report)) {
    if (issues.length === 0) {
      continue;
    }
    const workspace = workspaceOf(file);
    const snapshot = summary.get(workspace) ?? {
      count: 0,
      files: new Map<string, number>(),
    };
    snapshot.count += issues.length;
    snapshot.files.set(file, (snapshot.files.get(file) ?? 0) + issues.length);
    summary.set(workspace, snapshot);
  }
  return sortedSummary(
    Object.fromEntries(
      Array.from(
        summary,
        ([workspace, { count, files }]) =>
          [workspace, { count, files: Object.fromEntries(files) }] as const,
      ),
    ),
  );
};

// Symbol names per file, so a failing gate names what to delete rather than
// only how many.
export const collectIssueSymbols = (
  report: unknown,
): Record<string, readonly string[]> => {
  const symbols = new Map<string, string[]>();
  for (const { file, issues } of parseKnipReport(report)) {
    for (const { type, name } of issues) {
      const named = symbols.get(file) ?? [];
      named.push(`${name} (${type})`);
      symbols.set(file, named);
    }
  }
  return Object.fromEntries(symbols);
};

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

  const stdout = knip.stdout.toString();
  // The generation preflight may report a cache hit before knip writes JSON.
  // Anchor on the reporter's top-level shape rather than accepting arbitrary
  // trailing output as a report.
  const reportStart = stdout.indexOf('{"issues":');
  const parsed = Result.try((): unknown =>
    JSON.parse(reportStart === -1 ? stdout : stdout.slice(reportStart)),
  );
  if (Result.isError(parsed)) {
    panic(
      `knip did not produce JSON output:\n${knip.stderr.toString().trim() || stdout.trim()}`,
    );
  }
  return parsed.value;
};

const totalOf = (summary: Summary): number =>
  Object.values(summary).reduce((total, { count }) => total + count, 0);

const runReport = (): number => {
  const current = summarizeKnipReport(runKnip());
  console.log("knip dead exports: current counts\n");
  for (const [workspace, snapshot] of Object.entries(current)) {
    console.log(
      `  ${workspace.padEnd(32)} ${String(snapshot.count).padStart(5)}`,
    );
  }
  console.log(
    `\n  ${"total".padEnd(32)} ${String(totalOf(current)).padStart(5)}`,
  );
  return 0;
};

const runCheck = (): number => {
  const report = runKnip();
  const current = summarizeKnipReport(report);
  const workspaces = Object.entries(current);
  if (workspaces.length === 0) {
    console.log("knip dead exports --check: OK. 0 unused exports.");
    return 0;
  }

  const symbols = collectIssueSymbols(report);
  console.error("\nknip dead exports --check: unused export(s) found:\n");
  for (const [workspace, snapshot] of workspaces) {
    console.error(`  ${workspace}: ${String(snapshot.count)}`);
    for (const [file, count] of Object.entries(snapshot.files)) {
      console.error(`      ${file}: ${String(count)}`);
      for (const symbol of symbols[file] ?? []) {
        console.error(`        ${symbol}`);
      }
    }
  }
  console.error(
    "\nDelete the unused export, or reference it from a real runtime or test path.",
  );
  return 1;
};

type RatchetRunners = {
  readonly report: () => number;
  readonly check: () => number;
};

type RunKnipExportsRatchetOptions = {
  readonly args: readonly string[];
  readonly repoRoot?: string;
  readonly fileExists?: (file: string) => boolean;
  readonly runners?: RatchetRunners;
  readonly reportError?: (message: string) => void;
};

export const runKnipExportsRatchet = ({
  args,
  repoRoot = REPO_ROOT,
  fileExists = existsSync,
  runners = {
    report: runReport,
    check: runCheck,
  },
  reportError = console.error,
}: RunKnipExportsRatchetOptions): number => {
  const error = validateKnipGeneratedEntries(repoRoot, fileExists);
  if (error !== undefined) {
    reportError(`${error._tag}: ${error.message}`);
    return 1;
  }
  return args.includes("--check") ? runners.check() : runners.report();
};

if (import.meta.main) {
  process.exit(runKnipExportsRatchet({ args: process.argv }));
}
