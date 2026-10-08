import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  type AggregateLockBaselineRow,
  type AggregateLockRekey,
  aggregateLockSourceIncluded,
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../.oxlint-plugins/aggregate-lock-sites.ts";
import { BASELINE_PATHS } from "./baseline-paths";

export { aggregateLockSourceIncluded } from "../.oxlint-plugins/aggregate-lock-sites.ts";

export const AGGREGATE_LOCK_BASELINE_PATH = BASELINE_PATHS.aggregateLocks;
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

/** One reviewed file per PR, named after it: `scripts/aggregate-lock-rekeys/<pr-slug>.json`. */
export const AGGREGATE_LOCK_REKEYS_DIR = "scripts/aggregate-lock-rekeys";
const rekeySchema = v.array(
  v.strictObject({
    file: v.string(),
    from: v.string(),
    to: v.string(),
    fromFile: v.optional(v.string()),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
);
export const parseAggregateLockRekeys = (text: string): AggregateLockRekey[] =>
  v.parse(rekeySchema, JSON.parse(text));
const readAggregateLockRekeys = (): AggregateLockRekey[] =>
  existsSync(AGGREGATE_LOCK_REKEYS_DIR)
    ? readdirSync(AGGREGATE_LOCK_REKEYS_DIR)
        .filter((name) => name.endsWith(".json"))
        .toSorted()
        .flatMap((name) =>
          parseAggregateLockRekeys(
            readFileSync(path.join(AGGREGATE_LOCK_REKEYS_DIR, name), "utf-8"),
          ),
        )
    : [];

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
  const explicitBase = process.env["BASE_SHA"];
  const requestedBase = process.env["BASE_REF"] ?? "origin/main";
  const base = git(
    explicitBase
      ? ["rev-parse", "--verify", `${explicitBase}^{commit}`]
      : ["merge-base", "HEAD", requestedBase],
  ).trim();
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
    rekeys: readAggregateLockRekeys(),
  });
};
if (import.meta.main) {
  if (Bun.argv.includes("--generate")) {
    const files = git(["ls-files"])
      .trim()
      .split("\n")
      .filter(aggregateLockSourceIncluded);
    const existing = existsSync(AGGREGATE_LOCK_BASELINE_PATH)
      ? parseAggregateLockBaseline(
          readFileSync(AGGREGATE_LOCK_BASELINE_PATH, "utf-8"),
        )
      : [];
    const rekeys = readAggregateLockRekeys();
    const reasons = new Map([
      ...existing.map(
        (row) => [`${row.file}:${row.fingerprint}`, row.reason] as const,
      ),
      ...rekeys.map(
        (rekey) => [`${rekey.file}:${rekey.to}`, rekey.reason] as const,
      ),
    ]);
    const rows = aggregateLockBaseline(
      files.flatMap((file) =>
        aggregateLockSites(file, readFileSync(file, "utf-8")),
      ),
    ).map((row) => ({
      ...row,
      reason: reasons.get(`${row.file}:${row.fingerprint}`) ?? row.reason,
    }));
    const problems = aggregateLockBaselineProblems({
      actual: rows,
      baseline: rows,
      previous: previousAggregateLocks(rows),
      rekeys,
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
