#!/usr/bin/env bun

import { Result, TaggedError } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";

import { BASELINE_PATHS } from "./baseline-paths.ts";

class ActionlintBaselineError extends TaggedError("ActionlintBaselineError")<{
  message: string;
  cause?: unknown;
}> {}

type Finding = {
  filepath: string;
  kind: string;
  message: string;
};

const isFinding = (value: unknown): value is Finding =>
  typeof value === "object" &&
  value !== null &&
  "filepath" in value &&
  typeof value.filepath === "string" &&
  "kind" in value &&
  typeof value.kind === "string" &&
  "message" in value &&
  typeof value.message === "string";

const run = (): void => {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== "--check" && args[0] !== "--write")
  ) {
    throw new ActionlintBaselineError({
      message:
        "Usage: bun scripts/check-actionlint-baseline.ts [--check|--write]",
    });
  }
  const binary = process.env["ACTIONLINT_BIN"];
  if (!binary) {
    throw new ActionlintBaselineError({
      message: "ACTIONLINT_BIN is required",
    });
  }
  const result = Bun.spawnSync([binary, "-format", "{{json .}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Exit 1 reports diagnostics; all other nonzero statuses are tool failures.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new ActionlintBaselineError({
      message: `actionlint exited with status ${result.exitCode}: ${result.stderr.toString().trim()}`,
    });
  }
  const findings: unknown = JSON.parse(result.stdout.toString());
  if (!Array.isArray(findings) || !findings.every(isFinding)) {
    throw new ActionlintBaselineError({
      message:
        "actionlint output must be an array of findings with filepath, kind, and message strings",
    });
  }
  const groups = new Map<string, Finding & { count: number }>();
  for (const { filepath, kind, message } of findings) {
    const key = JSON.stringify([filepath, kind, message]);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, { count: 1, filepath, kind, message });
  }
  // jq group_by sorts tuples by Unicode code point, matching UTF-8 byte order.
  const grouped = [...groups.values()].toSorted((left, right) => {
    for (const field of ["filepath", "kind", "message"] as const) {
      const order = Buffer.compare(
        Buffer.from(left[field]),
        Buffer.from(right[field]),
      );
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
  const actual = `${JSON.stringify(grouped, null, 2)}\n`;
  const baseline = BASELINE_PATHS.actionlint;
  if (args.at(0) === "--write") {
    writeFileSync(baseline, actual);
    return;
  }
  const expected = readFileSync(baseline, "utf-8");
  if (expected === actual) {
    return;
  }
  const diff = [
    `--- ${baseline}`,
    "+++ actionlint actual",
    ...expected
      .trimEnd()
      .split("\n")
      .map((line) => `-${line}`),
    ...actual
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`),
  ].join("\n");
  throw new ActionlintBaselineError({
    message: `${diff}\nActionlint baseline differs; run with --write to re-anchor it.`,
  });
};

if (import.meta.main) {
  const result = Result.try({
    try: run,
    catch: (cause) =>
      ActionlintBaselineError.is(cause)
        ? cause
        : new ActionlintBaselineError({
            message: `Could not check actionlint baseline: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
  });
  if (Result.isError(result)) {
    console.error(result.error.message);
    process.exitCode = 1;
  }
}
