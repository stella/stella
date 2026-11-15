import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { compareCodeUnit } from "../packages/collation/src/collation";

/** Each compiler writes its own file; profiling is deliberately API-only. */
export const typecheckProfilePath = (
  project: string,
  directory: string | undefined,
): string | undefined =>
  project === "apps/api" && directory !== undefined && directory !== ""
    ? path.resolve(directory, "api-file-times.tsv")
    : undefined;

type FileCpu = { file: string; seconds: number };
type ProfileSummary =
  { ok: true; rows: FileCpu[] } | { ok: false; error: string };

/** tsrs emits one TSV row per file check, so a file can occur more than once. */
export const summarizeTypecheckFileTimes = (text: string): ProfileSummary => {
  const totals = new Map<string, number>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line === "") {
      continue;
    }
    // checker, wall seconds, thread CPU seconds, nodes, bytes, imports, path,
    // node-kind histogram. Only thread CPU seconds rank the diagnostic view.
    const fields = line.split("\t");
    const file = fields[6];
    const cpu = fields[2];
    const seconds = Number(cpu);
    if (
      fields.length !== 8 ||
      file === undefined ||
      file === "" ||
      cpu === undefined ||
      cpu.trim() === "" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return {
        ok: false,
        error: `Invalid tsrs file timing at line ${index + 1}`,
      };
    }
    totals.set(file, (totals.get(file) ?? 0) + seconds);
  }
  const rows = [...totals]
    .map(([file, seconds]) => ({ file, seconds }))
    .toSorted(
      (left, right) =>
        right.seconds - left.seconds || compareCodeUnit(left.file, right.file),
    );
  return { ok: true, rows };
};

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined || process.argv.length !== 3) {
    console.error("Usage: bun scripts/typecheck-profile.ts <file.tsv>");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.log(
      "API typecheck profile was not written before compilation ended.",
    );
  } else {
    console.log(
      "API typecheck CPU hotspots (top 20; not per-file instantiation counts).\n" +
        "Profiling retains ASTs: memory/time are instrumented, not comparable " +
        "with unprofiled runs. Imported work may be charged to its first caller.",
    );
    const summary = summarizeTypecheckFileTimes(readFileSync(file, "utf-8"));
    if (!summary.ok) {
      console.error(summary.error);
      process.exit(1);
    }
    for (const row of summary.rows.slice(0, 20)) {
      console.log(
        `${row.seconds.toFixed(6)}s\t${repoRelativePath(process.cwd(), row.file)}`,
      );
    }
  }
}
