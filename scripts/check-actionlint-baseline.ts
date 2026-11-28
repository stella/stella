#!/usr/bin/env bun

import { Result, TaggedError } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { actionlintWorkflowSource } from "./check-workflow-yaml";

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
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new ActionlintBaselineError({
      message: "Usage: bun scripts/check-actionlint-baseline.ts [--check]",
    });
  }
  const binary = process.env["ACTIONLINT_BIN"];
  if (!binary) {
    throw new ActionlintBaselineError({
      message: "ACTIONLINT_BIN is required",
    });
  }
  const directory = ".github/workflows";
  const files = readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .toSorted();
  if (files.length === 0) {
    throw new ActionlintBaselineError({ message: "No workflow files to lint" });
  }
  const sources = files.map((name) => {
    const file = path.join(directory, name);
    return {
      file,
      source: actionlintWorkflowSource({
        source: readFileSync(file, "utf-8"),
        root: process.cwd(),
        file,
      }),
    };
  });
  const invocations = sources.map(({ file, source }) => ({
    args: [binary, "-format", "{{json .}}", "-stdin-filename", file, "-"],
    stdin: Buffer.from(source),
  }));
  const findings: unknown[] = [];
  for (const invocation of invocations) {
    const result = Bun.spawnSync(invocation.args, {
      stdin: invocation.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Exit 1 reports diagnostics; all other nonzero statuses are tool failures.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ActionlintBaselineError({
        message: `actionlint exited with status ${result.exitCode}: ${result.stderr.toString().trim()}`,
      });
    }
    const reported: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(reported) || !reported.every(isFinding)) {
      throw new ActionlintBaselineError({
        message:
          "actionlint output must be an array of findings with filepath, kind, and message strings",
      });
    }
    findings.push(...reported);
  }
  if (!findings.every(isFinding)) {
    throw new ActionlintBaselineError({
      message: "Invalid actionlint findings",
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
  if (grouped.length === 0) {
    return;
  }
  throw new ActionlintBaselineError({
    message: `actionlint reported ${String(grouped.length)} finding group(s):\n${JSON.stringify(grouped, null, 2)}`,
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
