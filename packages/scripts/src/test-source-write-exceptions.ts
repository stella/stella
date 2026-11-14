import { Result } from "better-result";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "./child-exit-status";

const LEDGER_PATH = "scripts/test-source-write-exceptions.json";
const GIT_TIMEOUT_MS = 5000;

type SourceWriteException = {
  source: string;
  operation: string;
  destination: string;
  reason: string;
};

const exceptionKey = ({
  source,
  operation,
  destination,
}: SourceWriteException) =>
  `${source}: ${operation} writes into src (${destination})`;

const parseExceptions = (text: string) => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  const entries: SourceWriteException[] = [];
  const issues: string[] = [];
  if (parsed.isErr() || !Array.isArray(parsed.value)) {
    return {
      entries,
      issues: ["Source-write exception ledger must be a JSON array"],
    };
  }
  for (const entry of parsed.value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("source" in entry) ||
      typeof entry.source !== "string" ||
      !("operation" in entry) ||
      typeof entry.operation !== "string" ||
      !("destination" in entry) ||
      typeof entry.destination !== "string" ||
      !("reason" in entry) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim() === ""
    ) {
      issues.push(
        "Source-write exceptions require source, operation, destination, and a reason",
      );
      continue;
    }
    entries.push({
      source: entry.source,
      operation: entry.operation,
      destination: entry.destination,
      reason: entry.reason,
    });
  }
  if (new Set(entries.map(exceptionKey)).size !== entries.length) {
    issues.push("Source-write exceptions must not be duplicated");
  }
  return { entries, issues };
};

type ValidateSourceWriteExceptionsOptions = {
  observed: string[];
  current: string;
  baseline: string | null;
};

export const validateSourceWriteExceptions = ({
  observed,
  current,
  baseline,
}: ValidateSourceWriteExceptionsOptions) => {
  const ledger = parseExceptions(current);
  const previous = baseline === null ? null : parseExceptions(baseline);
  const issues = [...ledger.issues, ...(previous?.issues ?? [])];
  const keys = ledger.entries.map(exceptionKey).toSorted();
  const actual = observed
    .map((violation) => violation.replace(/:\d+: /u, ": "))
    .toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(actual)) {
    issues.push(
      `Source-write exceptions must equal observed debt: ${JSON.stringify({ expected: keys, observed: actual })}`,
    );
  }
  if (previous !== null) {
    const baselineKeys = new Set(previous.entries.map(exceptionKey));
    for (const key of keys) {
      if (!baselineKeys.has(key)) {
        issues.push(`Source-write exceptions may only shrink: ${key}`);
      }
    }
  }
  return issues;
};

type SourceWriteExceptionIssuesOptions = {
  root: string;
  observed: string[];
  git?: (
    args: string[],
  ) => Pick<
    SpawnSyncReturns<string>,
    "status" | "signal" | "error" | "stdout" | "stderr"
  >;
};

// Match the app-boundary ledger: the first rollout establishes a reviewed
// baseline; subsequent branches compare against the main merge base.
export const sourceWriteExceptionIssues = ({
  root,
  observed,
  git = (args) =>
    spawnSync("git", args, {
      maxBuffer: 2 ** 30,
      cwd: root,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }),
}: SourceWriteExceptionIssuesOptions) => {
  const failure = (result: ReturnType<typeof git>) =>
    `exit status ${String(result.status)}, signal ${String(result.signal)}; ${result.error?.message || result.stderr.trim() || "git produced no diagnostic"}`;
  const configuredBase = process.env["GITHUB_BASE_REF"];
  const base = configuredBase ? `origin/${configuredBase}` : "origin/main";
  const mergeBase = git(["merge-base", "HEAD", base]);
  if (childExitStatus(mergeBase) !== 0) {
    return [
      `Source-write ledger merge base unavailable: ${failure(mergeBase)}`,
    ];
  }
  const revision = mergeBase.stdout.trim();
  const listed = git(["ls-tree", "--full-tree", revision, "--", LEDGER_PATH]);
  if (childExitStatus(listed) !== 0) {
    return [`Source-write ledger baseline unavailable: ${failure(listed)}`];
  }
  let baseline: string | null = null;
  if (listed.stdout.trim() !== "") {
    const previous = git(["show", `${revision}:${LEDGER_PATH}`]);
    if (childExitStatus(previous) !== 0) {
      return [`Source-write ledger baseline unreadable: ${failure(previous)}`];
    }
    baseline = previous.stdout;
  }
  return validateSourceWriteExceptions({
    observed,
    current: readFileSync(path.join(root, LEDGER_PATH), "utf-8"),
    baseline,
  });
};
