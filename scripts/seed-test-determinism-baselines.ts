import { panic, Result } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { isRecord } from "./oxlint-config-scopes.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RULES = {
  "no-wallclock-assertions-in-tests": BASELINE_PATHS.testWallclockAssertion,
  "no-real-timers-in-tests": BASELINE_PATHS.testRealTimers,
  "no-ambient-time-in-tests": BASELINE_PATHS.testAmbientTime,
} as const;
const isRule = (value: string): value is keyof typeof RULES =>
  Object.hasOwn(RULES, value);

type Entry = { count: number; owner: string; reason: string };
type RetainedCensusEntriesOptions = {
  reviewed: Record<string, unknown>;
  selected: ReadonlySet<string>;
  tracked: ReadonlySet<string>;
};

export const retainedCensusEntries = ({
  reviewed,
  selected,
  tracked,
}: RetainedCensusEntriesOptions) => {
  const retained = new Map<string, Entry>();
  for (const [file, entry] of Object.entries(reviewed)) {
    if (selected.has(file) || !tracked.has(file)) {
      continue;
    }
    if (
      !isRecord(entry) ||
      typeof entry["count"] !== "number" ||
      typeof entry["owner"] !== "string" ||
      typeof entry["reason"] !== "string"
    ) {
      panic(`Invalid reviewed determinism entry for ${file}`);
    }
    retained.set(file, {
      count: entry["count"],
      owner: entry["owner"],
      reason: entry["reason"],
    });
  }
  return retained;
};

type CensusEntryOptions = {
  file: string;
  current: Entry | undefined;
  reviewed: unknown;
};

export const censusEntry = ({
  file,
  current,
  reviewed,
}: CensusEntryOptions): Entry => {
  if (current !== undefined) {
    return {
      count: current.count + 1,
      owner: current.owner,
      reason: current.reason,
    };
  }
  if (reviewed !== undefined) {
    if (
      !isRecord(reviewed) ||
      typeof reviewed["owner"] !== "string" ||
      typeof reviewed["reason"] !== "string"
    ) {
      panic(`Invalid reviewed determinism entry for ${file}`);
    }
    return { count: 1, owner: reviewed["owner"], reason: reviewed["reason"] };
  }
  const parts = file.split("/");
  return {
    count: 1,
    owner:
      parts.at(0) === "apps" || parts.at(0) === "packages"
        ? (parts.at(1) ?? "tooling")
        : (parts.at(0) ?? "tooling"),
    reason: "pre-kit census; migrate to @stll/test-kit",
  };
};

if (import.meta.main) {
  const baselines = new Map(
    Object.keys(RULES).map((rule) => [rule, new Map<string, Entry>()]),
  );
  const reviewed = new Map(
    Object.entries(RULES).map(([rule, file]) => {
      const entries: unknown = JSON.parse(
        readFileSync(path.join(ROOT, file), "utf-8"),
      );
      if (!isRecord(entries)) {
        panic(`Invalid determinism baseline ${file}`);
      }
      return [rule, entries] as const;
    }),
  );
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (tracked.exitCode !== 0) {
    panic("Could not enumerate tracked test files");
  }
  const files = tracked.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
        !file.startsWith("packages/test-kit/") &&
        // Negative specimens must retain firing suppressions, never a budget.
        !file.startsWith(".oxlint-plugins/__fixtures__/"),
    );
  const selected = process.argv.slice(2);
  for (const file of selected) {
    if (!files.includes(file)) {
      panic(`Not a tracked test file: ${file}`);
    }
  }
  const censusFiles = selected.length === 0 ? files : selected;
  if (selected.length > 0) {
    for (const [rule, entries] of reviewed) {
      const baseline = baselines.get(rule);
      if (baseline === undefined) {
        panic(`Missing census rule ${rule}`);
      }
      for (const [file, entry] of retainedCensusEntries({
        reviewed: entries,
        selected: new Set(selected),
        tracked: new Set(files),
      })) {
        baseline.set(file, entry);
      }
    }
  }
  const temporary = mkdtempSync(
    path.join(tmpdir(), "test-determinism-census-"),
  );
  const result = Result.try(() => {
    const config = path.join(temporary, "oxlint.json");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: Object.keys(RULES).map((rule) =>
          path.join(ROOT, ".oxlint-plugins", `${rule}.ts`),
        ),
        settings: { testDeterminismCensus: true },
        rules: Object.fromEntries(
          Object.keys(RULES).map((rule) => [`${rule}/${rule}`, "error"]),
        ),
      }),
    );
    // Bound both argument bytes and the work assigned to each lint process.
    const BATCH_SIZE = 200;
    for (let offset = 0; offset < censusFiles.length; offset += BATCH_SIZE) {
      const lint = Bun.spawnSync(
        [
          process.execPath,
          "--bun",
          path.join(ROOT, "node_modules/.bin/oxlint"),
          "-c",
          config,
          "--threads=1",
          "--no-ignore",
          "--disable-nested-config",
          "-f",
          "json",
          ...censusFiles.slice(offset, offset + BATCH_SIZE),
        ],
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      );
      if (
        (lint.exitCode !== 0 && lint.exitCode !== 1) ||
        lint.stdout.length === 0
      ) {
        panic(`Census lint failed: ${lint.stderr.toString()}`);
      }
      const report: unknown = JSON.parse(lint.stdout.toString());
      if (!isRecord(report) || !Array.isArray(report["diagnostics"])) {
        panic("Census lint returned no diagnostics");
      }
      for (const diagnostic of report["diagnostics"]) {
        if (
          !isRecord(diagnostic) ||
          typeof diagnostic["code"] !== "string" ||
          typeof diagnostic["filename"] !== "string"
        ) {
          panic("Census encountered a parser/configuration error");
        }
        const rule = diagnostic["code"].split("(").at(0) ?? "";
        if (!isRule(rule)) {
          panic(`Unexpected census diagnostic: ${diagnostic["code"]}`);
        }
        const file = repoRelativePath(
          ROOT,
          path.resolve(ROOT, diagnostic["filename"]),
        );
        const baseline = baselines.get(rule);
        if (baseline === undefined) {
          panic(`Missing census rule ${rule}`);
        }
        const entry = censusEntry({
          file,
          current: baseline.get(file),
          reviewed: reviewed.get(rule)?.[file],
        });
        baseline.set(file, entry);
      }
    }
    for (const [rule, baseline] of baselines) {
      if (!isRule(rule)) {
        panic(`Unexpected census rule ${rule}`);
      }
      writeFileSync(
        path.join(ROOT, RULES[rule]),
        `${JSON.stringify(
          Object.fromEntries(
            [...baseline].toSorted(([a], [b]) => {
              if (a === b) {
                return 0;
              }
              return a < b ? -1 : 1;
            }),
          ),
          null,
          2,
        )}\n`,
      );
      console.log(
        `${rule}: ${baseline.size} files, ${[...baseline.values()].reduce((sum, entry) => sum + entry.count, 0)} occurrences`,
      );
    }
  });
  rmSync(temporary, { recursive: true, force: true });
  if (Result.isError(result)) {
    panic(`Test determinism census failed: ${result.error.message}`);
  }
}
