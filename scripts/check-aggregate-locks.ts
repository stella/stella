import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  type AggregateLockBaselineRow,
  aggregateLockSourceIncluded,
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../.oxlint-plugins/aggregate-lock-sites.ts";

export { aggregateLockSourceIncluded } from "../.oxlint-plugins/aggregate-lock-sites.ts";

export const AGGREGATE_LOCK_BASELINE_PATH =
  "scripts/aggregate-lock-baseline.json";
const baselineSchema = v.array(
  v.object({
    file: v.string(),
    fingerprint: v.string(),
    count: v.number(),
    reason: v.string(),
  }),
);
export const parseAggregateLockBaseline = (text: string) =>
  v.parse(baselineSchema, JSON.parse(text));

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    panic(
      `Aggregate lock inventory git command failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};
type AggregateLockGitSource = { file: string; source: string };
export const parseAggregateLockGitBatch = (
  data: Buffer,
  files: readonly string[],
): AggregateLockGitSource[] => {
  const sources: AggregateLockGitSource[] = [];
  let offset = 0;
  for (const file of files) {
    const end = data.indexOf(10, offset);
    if (end === -1) {
      return panic("Incomplete aggregate lock source header");
    }
    const header = data.subarray(offset, end).toString("utf-8");
    offset = end + 1;
    if (header.endsWith(" missing")) {
      continue;
    }
    const sizeText = /^[a-f0-9]+ blob ([0-9]+)$/u.exec(header)?.at(1);
    if (sizeText === undefined) {
      return panic(`Invalid aggregate lock source header: ${header}`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || data.at(offset + size) !== 10) {
      return panic("Incomplete aggregate lock source body");
    }
    sources.push({
      file,
      source: data.subarray(offset, offset + size).toString("utf-8"),
    });
    offset += size + 1;
  }
  if (offset !== data.length) {
    return panic("Unexpected aggregate lock source data");
  }
  return sources;
};
const previousAggregateLocks = (rows: readonly AggregateLockBaselineRow[]) => {
  const base = git(["merge-base", "HEAD", "origin/main"]).trim();
  const existing = Bun.spawnSync([
    "git",
    "cat-file",
    "-e",
    `${base}:${AGGREGATE_LOCK_BASELINE_PATH}`,
  ]);
  if (existing.exitCode === 0) {
    return parseAggregateLockBaseline(
      git(["show", `${base}:${AGGREGATE_LOCK_BASELINE_PATH}`]),
    );
  }
  // Bootstrap is tied to the base source, so a newly introduced acquisition
  // cannot be enrolled merely by regenerating the first baseline.
  const files = [...new Set(rows.map((row) => row.file))].toSorted();
  if (files.length === 0) {
    return [];
  }
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    stdin: Buffer.from(files.map((file) => `${base}:${file}\n`).join("")),
  });
  if (result.exitCode !== 0) {
    return panic(
      `Aggregate lock source inventory failed: ${result.stderr.toString()}`,
    );
  }
  const sources = parseAggregateLockGitBatch(result.stdout, files);
  return aggregateLockBaseline(
    sources.flatMap(({ file, source }) => aggregateLockSites(file, source)),
  );
};
export const checkAggregateLocks = () => {
  const files = git(["ls-files"])
    .trim()
    .split("\n")
    .filter(aggregateLockSourceIncluded);
  const actual = aggregateLockBaseline(
    files.flatMap((file) =>
      aggregateLockSites(file, readFileSync(file, "utf-8")),
    ),
  );
  const baseline = parseAggregateLockBaseline(
    readFileSync(AGGREGATE_LOCK_BASELINE_PATH, "utf-8"),
  );
  return aggregateLockBaselineProblems({
    actual,
    baseline,
    previous: previousAggregateLocks(baseline),
  });
};
if (import.meta.main) {
  if (Bun.argv.includes("--generate")) {
    const files = git(["ls-files"])
      .trim()
      .split("\n")
      .filter(aggregateLockSourceIncluded);
    const rows = aggregateLockBaseline(
      files.flatMap((file) =>
        aggregateLockSites(file, readFileSync(file, "utf-8")),
      ),
    );
    const problems = aggregateLockBaselineProblems({
      actual: rows,
      baseline: rows,
      previous: previousAggregateLocks(rows),
    });
    if (problems.length) {
      panic(problems.join("\n"));
    }
    writeFileSync(
      path.resolve(AGGREGATE_LOCK_BASELINE_PATH),
      `${JSON.stringify(rows, null, 2)}\n`,
    );
  } else {
    const problems = checkAggregateLocks();
    if (problems.length) {
      panic(problems.join("\n"));
    }
    console.log("Aggregate lock inventory matches its shrinking baseline.");
  }
}
